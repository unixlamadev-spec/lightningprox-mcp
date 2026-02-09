package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// ============================================================================
// LightningProx MCP Server
// Gives AI agents the ability to query AI models via Lightning Network payments
// Tools: ask_ai, get_invoice, check_balance, list_models, get_pricing
// ============================================================================

const (
	DefaultLightningProxURL = "https://lightningprox.com"
	ServerName              = "lightningprox-mcp"
	ServerVersion           = "1.0.0"
)

// --- Tool Input/Output Types ---

// AskAIInput is the input for the ask_ai tool
type AskAIInput struct {
	Model       string `json:"model" jsonschema:"description=The AI model to use (e.g. claude-sonnet-4-20250514 or gpt-4o)"`
	Prompt      string `json:"prompt" jsonschema:"description=The message or prompt to send to the AI model"`
	MaxTokens   int    `json:"max_tokens,omitempty" jsonschema:"description=Maximum tokens in the response (default 1024)"`
	PaymentHash string `json:"payment_hash,omitempty" jsonschema:"description=Payment hash from a previously paid invoice. If not provided a new invoice will be generated."`
	SpendToken  string `json:"spend_token,omitempty" jsonschema:"description=Prepaid spend token for balance-based access. Overrides payment_hash if provided."`
}

type AskAIOutput struct {
	Response    string `json:"response,omitempty"`
	ChargeID    string `json:"charge_id,omitempty"`
	PaymentReq  string `json:"payment_request,omitempty"`
	AmountSats  int    `json:"amount_sats,omitempty"`
	AmountUSD   float64 `json:"amount_usd,omitempty"`
	Status      string `json:"status"`
	Error       string `json:"error,omitempty"`
}

// GetInvoiceInput generates a Lightning invoice for prepaid access
type GetInvoiceInput struct {
	Model     string `json:"model" jsonschema:"description=The AI model to generate an invoice for"`
	MaxTokens int    `json:"max_tokens,omitempty" jsonschema:"description=Expected max tokens (affects invoice amount)"`
	Prompt    string `json:"prompt" jsonschema:"description=The prompt you intend to send (used to estimate cost)"`
}

type GetInvoiceOutput struct {
	ChargeID   string  `json:"charge_id"`
	PaymentReq string  `json:"payment_request"`
	AmountSats int     `json:"amount_sats"`
	AmountUSD  float64 `json:"amount_usd"`
	ExpiresAt  string  `json:"expires_at"`
	Status     string  `json:"status"`
}

// CheckBalanceInput checks a prepaid spend token balance
type CheckBalanceInput struct {
	SpendToken string `json:"spend_token" jsonschema:"description=The prepaid spend token to check balance for"`
}

type CheckBalanceOutput struct {
	BalanceSats  int    `json:"balance_sats"`
	BalanceUSD   float64 `json:"balance_usd"`
	RequestsLeft int    `json:"requests_left_estimate"`
	ExpiresAt    string `json:"expires_at"`
	Status       string `json:"status"`
}

// ListModelsInput (no params needed)
type ListModelsInput struct{}

type ModelInfo struct {
	ID          string  `json:"id"`
	Provider    string  `json:"provider"`
	InputCost   float64 `json:"input_cost_per_1k_tokens"`
	OutputCost  float64 `json:"output_cost_per_1k_tokens"`
	MaxContext  int     `json:"max_context_tokens"`
}

type ListModelsOutput struct {
	Models []ModelInfo `json:"models"`
}

// GetPricingInput estimates cost for a request
type GetPricingInput struct {
	Model     string `json:"model" jsonschema:"description=The model to get pricing for"`
	MaxTokens int    `json:"max_tokens,omitempty" jsonschema:"description=Expected output tokens (default 1024)"`
}

type GetPricingOutput struct {
	Model           string  `json:"model"`
	EstimatedSats   int     `json:"estimated_sats"`
	EstimatedUSD    float64 `json:"estimated_usd"`
	InputCostPer1K  float64 `json:"input_cost_per_1k_tokens"`
	OutputCostPer1K float64 `json:"output_cost_per_1k_tokens"`
	Markup          string  `json:"markup"`
}

// --- HTTP Client Helpers ---

func getLightningProxURL() string {
	if url := os.Getenv("LIGHTNINGPROX_URL"); url != "" {
		return strings.TrimRight(url, "/")
	}
	return DefaultLightningProxURL
}

func makeRequest(method, url string, body interface{}, headers map[string]string) ([]byte, int, error) {
	var reqBody io.Reader
	if body != nil {
		jsonBytes, err := json.Marshal(body)
		if err != nil {
			return nil, 0, fmt.Errorf("failed to marshal request: %w", err)
		}
		reqBody = bytes.NewReader(jsonBytes)
	}

	req, err := http.NewRequest(method, url, reqBody)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "lightningprox-mcp/1.0")
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, fmt.Errorf("failed to read response: %w", err)
	}

	return respBody, resp.StatusCode, nil
}

// --- Tool Handlers ---

func handleAskAI(ctx context.Context, req *mcp.CallToolRequest, input AskAIInput) (*mcp.CallToolResult, AskAIOutput, error) {
	baseURL := getLightningProxURL()

	maxTokens := input.MaxTokens
	if maxTokens <= 0 {
		maxTokens = 1024
	}

	model := input.Model
	if model == "" {
		model = "claude-sonnet-4-20250514"
	}

	// Build the request body
	requestBody := map[string]interface{}{
		"model":      model,
		"max_tokens": maxTokens,
		"messages": []map[string]string{
			{"role": "user", "content": input.Prompt},
		},
	}

	// Build headers
	headers := make(map[string]string)
	if input.SpendToken != "" {
		headers["X-Spend-Token"] = input.SpendToken
	} else if input.PaymentHash != "" {
		headers["X-Payment-Hash"] = input.PaymentHash
	}

	// All models go through /v1/messages on LightningProx
	endpoint := "/v1/messages"

	respBody, statusCode, err := makeRequest("POST", baseURL+endpoint, requestBody, headers)
	if err != nil {
		return nil, AskAIOutput{Status: "error", Error: err.Error()}, nil
	}

	// Parse response
	var respData map[string]interface{}
	if err := json.Unmarshal(respBody, &respData); err != nil {
		return nil, AskAIOutput{Status: "error", Error: "failed to parse response"}, nil
	}

	// If payment required (402), return invoice details
	if statusCode == 402 {
		payment, _ := respData["payment"].(map[string]interface{})
		chargeID, _ := payment["charge_id"].(string)
		paymentReq, _ := payment["payment_request"].(string)
		amountSats, _ := payment["amount_sats"].(float64)
		amountUSD, _ := payment["amount_usd"].(float64)

		output := AskAIOutput{
			Status:     "payment_required",
			ChargeID:   chargeID,
			PaymentReq: paymentReq,
			AmountSats: int(amountSats),
			AmountUSD:  amountUSD,
		}
		return nil, output, nil
	}

	if statusCode != 200 {
		errMsg, _ := respData["error"].(string)
		if errMsg == "" {
			errMsg = fmt.Sprintf("HTTP %d: %s", statusCode, string(respBody))
		}
		return nil, AskAIOutput{Status: "error", Error: errMsg}, nil
	}

	// Extract response text based on API format
	var responseText string
	if content, ok := respData["content"].([]interface{}); ok {
		// Anthropic format
		for _, block := range content {
			if b, ok := block.(map[string]interface{}); ok {
				if text, ok := b["text"].(string); ok {
					responseText += text
				}
			}
		}
	} else if choices, ok := respData["choices"].([]interface{}); ok {
		// OpenAI format
		for _, choice := range choices {
			if c, ok := choice.(map[string]interface{}); ok {
				if msg, ok := c["message"].(map[string]interface{}); ok {
					if text, ok := msg["content"].(string); ok {
						responseText += text
					}
				}
			}
		}
	}

	return nil, AskAIOutput{Status: "success", Response: responseText}, nil
}

func handleGetInvoice(ctx context.Context, req *mcp.CallToolRequest, input GetInvoiceInput) (*mcp.CallToolResult, GetInvoiceOutput, error) {
	baseURL := getLightningProxURL()

	model := input.Model
	if model == "" {
		model = "claude-sonnet-4-20250514"
	}
	maxTokens := input.MaxTokens
	if maxTokens <= 0 {
		maxTokens = 1024
	}
	prompt := input.Prompt
	if prompt == "" {
		prompt = "ping"
	}

	requestBody := map[string]interface{}{
		"model":      model,
		"max_tokens": maxTokens,
		"messages": []map[string]string{
			{"role": "user", "content": prompt},
		},
	}

	endpoint := "/v1/messages"

	respBody, statusCode, err := makeRequest("POST", baseURL+endpoint, requestBody, nil)
	if err != nil {
		return nil, GetInvoiceOutput{Status: "error"}, nil
	}

	if statusCode != 402 {
		return nil, GetInvoiceOutput{Status: fmt.Sprintf("unexpected_status_%d", statusCode)}, nil
	}

	var respData map[string]interface{}
	if err := json.Unmarshal(respBody, &respData); err != nil {
		return nil, GetInvoiceOutput{Status: "error"}, nil
	}

	payment, _ := respData["payment"].(map[string]interface{})
	chargeID, _ := payment["charge_id"].(string)
	paymentReq, _ := payment["payment_request"].(string)
	amountSats, _ := payment["amount_sats"].(float64)
	amountUSD, _ := payment["amount_usd"].(float64)

	return nil, GetInvoiceOutput{
		ChargeID:   chargeID,
		PaymentReq: paymentReq,
		AmountSats: int(amountSats),
		AmountUSD:  amountUSD,
		ExpiresAt:  time.Now().Add(15 * time.Minute).Format(time.RFC3339),
		Status:     "invoice_generated",
	}, nil
}

func handleCheckBalance(ctx context.Context, req *mcp.CallToolRequest, input CheckBalanceInput) (*mcp.CallToolResult, CheckBalanceOutput, error) {
	baseURL := getLightningProxURL()

	headers := map[string]string{
		"X-Spend-Token": input.SpendToken,
	}

	respBody, statusCode, err := makeRequest("GET", baseURL+"/v1/balance", nil, headers)
	if err != nil {
		return nil, CheckBalanceOutput{Status: "error"}, nil
	}

	if statusCode != 200 {
		return nil, CheckBalanceOutput{Status: fmt.Sprintf("error_%d", statusCode)}, nil
	}

	var respData map[string]interface{}
	if err := json.Unmarshal(respBody, &respData); err != nil {
		return nil, CheckBalanceOutput{Status: "error"}, nil
	}

	balanceSats, _ := respData["balance_sats"].(float64)
	balanceUSD, _ := respData["balance_usd"].(float64)
	requestsLeft, _ := respData["requests_left_estimate"].(float64)
	expiresAt, _ := respData["expires_at"].(string)

	return nil, CheckBalanceOutput{
		BalanceSats:  int(balanceSats),
		BalanceUSD:   balanceUSD,
		RequestsLeft: int(requestsLeft),
		ExpiresAt:    expiresAt,
		Status:       "ok",
	}, nil
}

func handleListModels(ctx context.Context, req *mcp.CallToolRequest, input ListModelsInput) (*mcp.CallToolResult, ListModelsOutput, error) {
	// Return the models LightningProx currently supports
	// These match isValidModel() on the backend
	models := []ModelInfo{
		{
			ID:         "claude-sonnet-4-20250514",
			Provider:   "anthropic",
			InputCost:  0.003,
			OutputCost: 0.015,
			MaxContext: 200000,
		},
		{
			ID:         "claude-3-5-sonnet-20241022",
			Provider:   "anthropic",
			InputCost:  0.003,
			OutputCost: 0.015,
			MaxContext: 200000,
		},
		{
			ID:         "gpt-4-turbo",
			Provider:   "openai",
			InputCost:  0.01,
			OutputCost: 0.03,
			MaxContext: 128000,
		},
		{
			ID:         "gpt-3.5-turbo",
			Provider:   "openai",
			InputCost:  0.0005,
			OutputCost: 0.0015,
			MaxContext: 16385,
		},
	}

	return nil, ListModelsOutput{Models: models}, nil
}

func handleGetPricing(ctx context.Context, req *mcp.CallToolRequest, input GetPricingInput) (*mcp.CallToolResult, GetPricingOutput, error) {
	model := input.Model
	if model == "" {
		model = "claude-sonnet-4-20250514"
	}
	maxTokens := input.MaxTokens
	if maxTokens <= 0 {
		maxTokens = 1024
	}

	// Pricing table (including 20% LightningProx markup)
	type pricing struct {
		inputCost  float64
		outputCost float64
	}
	prices := map[string]pricing{
		"claude-sonnet-4-20250514":   {0.003 * 1.2, 0.015 * 1.2},
		"claude-3-5-sonnet-20241022": {0.003 * 1.2, 0.015 * 1.2},
		"gpt-4-turbo":               {0.01 * 1.2, 0.03 * 1.2},
		"gpt-3.5-turbo":             {0.0005 * 1.2, 0.0015 * 1.2},
	}

	p, ok := prices[model]
	if !ok {
		p = pricing{0.003 * 1.2, 0.015 * 1.2} // default to sonnet pricing
	}

	// Estimate: assume ~100 input tokens (short prompt) + maxTokens output
	estimatedUSD := (100.0/1000.0)*p.inputCost + (float64(maxTokens)/1000.0)*p.outputCost

	// Convert to sats (rough: 1 BTC = ~$100,000 as of early 2026)
	btcPrice := 100000.0
	if envPrice := os.Getenv("BTC_PRICE_USD"); envPrice != "" {
		fmt.Sscanf(envPrice, "%f", &btcPrice)
	}
	estimatedSats := int((estimatedUSD / btcPrice) * 100_000_000)
	if estimatedSats < 1 {
		estimatedSats = 1
	}

	return nil, GetPricingOutput{
		Model:           model,
		EstimatedSats:   estimatedSats,
		EstimatedUSD:    estimatedUSD,
		InputCostPer1K:  p.inputCost,
		OutputCostPer1K: p.outputCost,
		Markup:          "20%",
	}, nil
}

// --- Main ---

func main() {
	log.SetOutput(os.Stderr) // MCP uses stdout for protocol messages
	log.Println("Starting LightningProx MCP Server v" + ServerVersion)

	server := mcp.NewServer(
		&mcp.Implementation{
			Name:    ServerName,
			Version: ServerVersion,
		},
		nil,
	)

	// Tool: ask_ai — Send a prompt to an AI model, paying via Lightning
	mcp.AddTool(server, &mcp.Tool{
		Name: "ask_ai",
		Description: `Send a prompt to an AI model via LightningProx. Payment is via Lightning Network.

If no payment_hash or spend_token is provided, returns a Lightning invoice that must be paid first.
After paying, call again with the charge_id as payment_hash to get the AI response.
If using a prepaid spend token, include it and the request is processed immediately.

Supports Anthropic models (claude-*) and OpenAI models (gpt-*, o1-*).`,
	}, handleAskAI)

	// Tool: get_invoice — Pre-generate an invoice without executing the request
	mcp.AddTool(server, &mcp.Tool{
		Name: "get_invoice",
		Description: `Generate a Lightning invoice for an AI request without executing it.
Use this to pre-pay before calling ask_ai with the resulting charge_id.
Useful for agents that want to confirm cost before committing.`,
	}, handleGetInvoice)

	// Tool: check_balance — Check prepaid spend token balance
	mcp.AddTool(server, &mcp.Tool{
		Name: "check_balance",
		Description: `Check the remaining balance on a prepaid spend token.
Returns balance in sats, estimated USD value, approximate requests remaining, and expiry time.`,
	}, handleCheckBalance)

	// Tool: list_models — List available AI models and their pricing
	mcp.AddTool(server, &mcp.Tool{
		Name:        "list_models",
		Description: `List all AI models available through LightningProx with their pricing and capabilities.`,
	}, handleListModels)

	// Tool: get_pricing — Estimate cost for a specific request
	mcp.AddTool(server, &mcp.Tool{
		Name: "get_pricing",
		Description: `Estimate the cost in sats and USD for a request to a specific model.
Useful for budget-conscious agents to compare costs before choosing a model.`,
	}, handleGetPricing)

	// Run on stdio transport (standard for Claude Desktop, Cursor, etc.)
	log.Println("MCP server ready, listening on stdio")
	if err := server.Run(context.Background(), &mcp.StdioTransport{}); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}

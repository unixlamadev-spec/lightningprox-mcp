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

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

const (
	DefaultLightningProxURL = "https://lightningprox.com"
)

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
			return nil, 0, err
		}
		reqBody = bytes.NewReader(jsonBytes)
	}

	req, err := http.NewRequest(method, url, reqBody)
	if err != nil {
		return nil, 0, err
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "lightningprox-mcp/1.0")

	for k, v := range headers {
		req.Header.Set(k, v)
	}

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, err
	}

	return respBody, resp.StatusCode, nil
}

// getArgs safely extracts the arguments map from a tool request.
// Handles both map[string]interface{} and any typed Arguments.
func getArgs(req mcp.CallToolRequest) map[string]interface{} {
	if m, ok := req.Params.Arguments.(map[string]interface{}); ok {
		return m
	}
	// Try via JSON round-trip as fallback
	data, err := json.Marshal(req.Params.Arguments)
	if err != nil {
		return map[string]interface{}{}
	}
	var m map[string]interface{}
	if err := json.Unmarshal(data, &m); err != nil {
		return map[string]interface{}{}
	}
	return m
}

func main() {
	log.SetOutput(os.Stderr)
	log.Println("Starting LightningProx MCP Server v1.0.0")

	s := server.NewMCPServer(
		"lightningprox-mcp",
		"1.0.0",
		server.WithToolCapabilities(true),
	)

	// Tool: ask_ai
	s.AddTool(
		mcp.NewTool("ask_ai",
			mcp.WithDescription("Send a prompt to an AI model via LightningProx. Payment via Lightning Network."),
			mcp.WithString("model",
				mcp.Required(),
				mcp.Description("AI model to use (e.g. claude-sonnet-4-20250514, gpt-4-turbo)")),
			mcp.WithString("prompt",
				mcp.Required(),
				mcp.Description("The message or prompt to send")),
			mcp.WithNumber("max_tokens",
				mcp.Description("Maximum tokens in response (default 1024)")),
			mcp.WithString("spend_token",
				mcp.Description("Prepaid spend token for balance-based access")),
			mcp.WithString("payment_hash",
				mcp.Description("Payment hash from a previously paid invoice")),
		),
		func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			args := getArgs(req)
			model, _ := args["model"].(string)
			prompt, _ := args["prompt"].(string)
			spendToken, _ := args["spend_token"].(string)
			paymentHash, _ := args["payment_hash"].(string)

			if model == "" || prompt == "" {
				return mcp.NewToolResultError("model and prompt are required"), nil
			}

			maxTokens := 1024
			if mt, ok := args["max_tokens"].(float64); ok && mt > 0 {
				maxTokens = int(mt)
			}

			baseURL := getLightningProxURL()
			body := map[string]interface{}{
				"model":      model,
				"max_tokens": maxTokens,
				"messages":   []map[string]string{{"role": "user", "content": prompt}},
			}

			headers := map[string]string{}
			if spendToken != "" {
				headers["X-Spend-Token"] = spendToken
			} else if paymentHash != "" {
				headers["X-Payment-Hash"] = paymentHash
			}

			respBody, statusCode, err := makeRequest("POST", baseURL+"/v1/messages", body, headers)
			if err != nil {
				return mcp.NewToolResultError(fmt.Sprintf("Request failed: %v", err)), nil
			}

			var result map[string]interface{}
			json.Unmarshal(respBody, &result)

			if statusCode == 402 {
				chargeID, _ := result["charge_id"].(string)
				payReq, _ := result["payment_request"].(string)
				amountSats, _ := result["amount_sats"].(float64)
				return mcp.NewToolResultText(fmt.Sprintf(
					"Payment required.\nAmount: %.0f sats\nCharge ID: %s\nInvoice: %s\n\nPay the invoice, then retry with payment_hash set to the charge_id.",
					amountSats, chargeID, payReq)), nil
			}

			if statusCode != 200 {
				errMsg, _ := result["error"].(string)
				return mcp.NewToolResultError(fmt.Sprintf("Error (%d): %s", statusCode, errMsg)), nil
			}

			// Anthropic format
			if content, ok := result["content"].([]interface{}); ok && len(content) > 0 {
				if block, ok := content[0].(map[string]interface{}); ok {
					if text, ok := block["text"].(string); ok {
						return mcp.NewToolResultText(text), nil
					}
				}
			}
			// OpenAI format
			if choices, ok := result["choices"].([]interface{}); ok && len(choices) > 0 {
				if choice, ok := choices[0].(map[string]interface{}); ok {
					if msg, ok := choice["message"].(map[string]interface{}); ok {
						if text, ok := msg["content"].(string); ok {
							return mcp.NewToolResultText(text), nil
						}
					}
				}
			}

			return mcp.NewToolResultText(string(respBody)), nil
		},
	)

	// Tool: get_invoice
	s.AddTool(
		mcp.NewTool("get_invoice",
			mcp.WithDescription("Generate a Lightning invoice for an AI request without executing it"),
			mcp.WithString("model",
				mcp.Required(),
				mcp.Description("AI model to generate invoice for")),
			mcp.WithString("prompt",
				mcp.Required(),
				mcp.Description("The prompt (used to estimate cost)")),
			mcp.WithNumber("max_tokens",
				mcp.Description("Expected max tokens")),
		),
		func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			args := getArgs(req)
			model, _ := args["model"].(string)
			prompt, _ := args["prompt"].(string)

			if model == "" || prompt == "" {
				return mcp.NewToolResultError("model and prompt are required"), nil
			}

			maxTokens := 1024
			if mt, ok := args["max_tokens"].(float64); ok && mt > 0 {
				maxTokens = int(mt)
			}

			baseURL := getLightningProxURL()
			body := map[string]interface{}{
				"model":      model,
				"max_tokens": maxTokens,
				"messages":   []map[string]string{{"role": "user", "content": prompt}},
			}

			respBody, _, err := makeRequest("POST", baseURL+"/v1/messages", body, nil)
			if err != nil {
				return mcp.NewToolResultError(fmt.Sprintf("Request failed: %v", err)), nil
			}

			var result map[string]interface{}
			json.Unmarshal(respBody, &result)

			chargeID, _ := result["charge_id"].(string)
			payReq, _ := result["payment_request"].(string)
			amountSats, _ := result["amount_sats"].(float64)

			return mcp.NewToolResultText(fmt.Sprintf(
				"Invoice generated:\nAmount: %.0f sats\nCharge ID: %s\nPayment Request: %s",
				amountSats, chargeID, payReq)), nil
		},
	)

	// Tool: check_balance
	s.AddTool(
		mcp.NewTool("check_balance",
			mcp.WithDescription("Check remaining balance on a prepaid spend token"),
			mcp.WithString("spend_token",
				mcp.Required(),
				mcp.Description("The spend token to check")),
		),
		func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			args := getArgs(req)
			token, _ := args["spend_token"].(string)
			if token == "" {
				return mcp.NewToolResultError("spend_token is required"), nil
			}

			baseURL := getLightningProxURL()
			headers := map[string]string{"X-Spend-Token": token}

			respBody, statusCode, err := makeRequest("GET", baseURL+"/v1/balance", nil, headers)
			if err != nil {
				return mcp.NewToolResultError(fmt.Sprintf("Request failed: %v", err)), nil
			}

			if statusCode != 200 {
				return mcp.NewToolResultError(fmt.Sprintf("Error: %s", string(respBody))), nil
			}

			var result map[string]interface{}
			json.Unmarshal(respBody, &result)

			balanceSats, _ := result["balance_sats"].(float64)
			requestsLeft, _ := result["requests_left_estimate"].(float64)
			expiresAt, _ := result["expires_at"].(string)
			status, _ := result["status"].(string)

			return mcp.NewToolResultText(fmt.Sprintf(
				"Token Status: %s\nBalance: %.0f sats\nEstimated requests remaining: %.0f\nExpires: %s",
				status, balanceSats, requestsLeft, expiresAt)), nil
		},
	)

	// Tool: list_models
	s.AddTool(
		mcp.NewTool("list_models",
			mcp.WithDescription("List all AI models available through LightningProx with pricing"),
		),
		func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			baseURL := getLightningProxURL()

			respBody, statusCode, err := makeRequest("GET", baseURL+"/api/capabilities", nil, nil)
			if err != nil {
				return mcp.NewToolResultError(fmt.Sprintf("Request failed: %v", err)), nil
			}

			if statusCode != 200 {
				return mcp.NewToolResultError(fmt.Sprintf("Error: %s", string(respBody))), nil
			}

			var result map[string]interface{}
			json.Unmarshal(respBody, &result)

			models, ok := result["models"].(map[string]interface{})
			if !ok {
				return mcp.NewToolResultText(string(respBody)), nil
			}

			var sb strings.Builder
			sb.WriteString("Available Models:\n\n")
			for name, info := range models {
				if m, ok := info.(map[string]interface{}); ok {
					provider, _ := m["provider"].(string)
					sb.WriteString(fmt.Sprintf("  %s (provider: %s)\n", name, provider))
				}
			}

			return mcp.NewToolResultText(sb.String()), nil
		},
	)

	// Tool: get_pricing
	s.AddTool(
		mcp.NewTool("get_pricing",
			mcp.WithDescription("Estimate the cost for a request to a specific model"),
			mcp.WithString("model",
				mcp.Required(),
				mcp.Description("Model to get pricing for")),
			mcp.WithNumber("max_tokens",
				mcp.Description("Expected output tokens (default 1024)")),
		),
		func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			args := getArgs(req)
			model, _ := args["model"].(string)
			if model == "" {
				return mcp.NewToolResultError("model is required"), nil
			}

			maxTokens := 1024
			if mt, ok := args["max_tokens"].(float64); ok && mt > 0 {
				maxTokens = int(mt)
			}

			baseURL := getLightningProxURL()

			respBody, _, err := makeRequest("GET", baseURL+"/api/capabilities", nil, nil)
			if err != nil {
				return mcp.NewToolResultError(fmt.Sprintf("Request failed: %v", err)), nil
			}

			var caps map[string]interface{}
			json.Unmarshal(respBody, &caps)

			models, ok := caps["models"].(map[string]interface{})
			if !ok {
				return mcp.NewToolResultError("Could not retrieve model info"), nil
			}

			modelInfo, ok := models[model].(map[string]interface{})
			if !ok {
				return mcp.NewToolResultError(fmt.Sprintf("Model '%s' not found", model)), nil
			}

			provider, _ := modelInfo["provider"].(string)
			inputCost, _ := modelInfo["input_cost_per_1k"].(float64)
			outputCost, _ := modelInfo["output_cost_per_1k"].(float64)

			estimatedCost := (100.0/1000.0)*inputCost + (float64(maxTokens)/1000.0)*outputCost
			estimatedSats := int(estimatedCost * 100000)
			if estimatedSats < 3 {
				estimatedSats = 3
			}

			return mcp.NewToolResultText(fmt.Sprintf(
				"Pricing for %s (%s):\nInput: $%.4f / 1K tokens\nOutput: $%.4f / 1K tokens\nEstimated cost for %d output tokens: ~%d sats\nNote: 20%% markup included in gateway pricing",
				model, provider, inputCost, outputCost, maxTokens, estimatedSats)), nil
		},
	)

	log.Println("MCP server ready, listening on stdio")
	if err := server.ServeStdio(s); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}

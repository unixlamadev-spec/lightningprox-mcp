.PHONY: build clean release

BINARY_NAME=mcp-server
CMD_PATH=./cmd/mcp-server

build:
	go build -o $(BINARY_NAME) $(CMD_PATH)

clean:
	rm -f $(BINARY_NAME) mcp-server-*

install:
	go install $(CMD_PATH)

release:
	GOOS=linux   GOARCH=amd64 go build -o mcp-server-linux-amd64   $(CMD_PATH)
	GOOS=linux   GOARCH=arm64 go build -o mcp-server-linux-arm64   $(CMD_PATH)
	GOOS=darwin  GOARCH=amd64 go build -o mcp-server-darwin-amd64  $(CMD_PATH)
	GOOS=darwin  GOARCH=arm64 go build -o mcp-server-darwin-arm64  $(CMD_PATH)
	GOOS=windows GOARCH=amd64 go build -o mcp-server-windows-amd64.exe $(CMD_PATH)

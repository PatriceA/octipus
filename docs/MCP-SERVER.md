# MCP Server

Standalone MCP server (`mcp-server/`) that exposes assistant capabilities as MCP tools for CLI models like Claude Code and Gemini CLI.

## Tools

| Tool | Description |
|------|-------------|
| `assistant_search` | Search the web via SearXNG |
| `assistant_fetch_page` | Fetch and extract text from a URL |
| `assistant_list_agents` | List running agents with status |
| `assistant_spawn_agent` | Spawn a new autonomous agent |
| `assistant_stop_agent` | Stop a running agent |
| `assistant_send_message` | Send a message to a running agent |
| `assistant_get_agent_events` | Get agent events (polling with cursor) |
| `assistant_list_sessions` | List recent chat sessions |
| `assistant_get_messages` | Get messages from a session |
| `assistant_list_models` | List available AI models |
| `assistant_model_health` | Get model health status |
| `assistant_chat` | Send a message through the orchestrator |
| `assistant_chat_with_expert` | Chat using a specific expert |
| `assistant_list_experts` | List available experts |
| `assistant_list_tools` | List available tools |
| `assistant_execute_tool` | Execute any tool function |
| `assistant_list_skills` | List domain knowledge skills |
| `assistant_get_skill` | Get skill details |
| `assistant_create_skill` | Create a custom domain knowledge skill |
| `assistant_update_skill` | Update an existing skill |
| `assistant_delete_skill` | Delete a custom skill |
| `assistant_search_knowledge` | Search the RAG knowledge base |
| `assistant_index_file` | Index a file into the knowledge base |
| `assistant_create_recurring_task` | Create a scheduled task |
| `assistant_list_recurring_tasks` | List recurring tasks |
| `assistant_update_recurring_task` | Update a recurring task |
| `assistant_delete_recurring_task` | Delete a recurring task |

## Setup

```bash
cd mcp-server && npm install && npm run build
```

## Claude Code (`.mcp.json`)

```json
{
  "mcpServers": {
    "assistant": {
      "command": "node",
      "args": ["mcp-server/dist/index.js"],
      "env": {
        "ASSISTANT_URL": "http://localhost:3005",
        "ASSISTANT_API_KEY": "<your-jwt-or-api-key>"
      }
    }
  }
}
```

## Gemini CLI (`.gemini/settings.json`)

```json
{
  "mcpServers": {
    "assistant": {
      "command": "node",
      "args": ["mcp-server/dist/index.js"],
      "env": {
        "ASSISTANT_URL": "http://localhost:3005",
        "ASSISTANT_API_KEY": "<your-jwt-or-api-key>"
      }
    }
  }
}
```

## HTTP Transport

```bash
node mcp-server/dist/index.js --transport http --port 3010
```

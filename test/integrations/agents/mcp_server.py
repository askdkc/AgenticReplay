"""An MCP server over stdio, for the check that records one and then takes it away.

Deliberately trivial and deliberately deterministic: the point of the check is the transport and
the replay, not the tool. `lookup` answers from its argument so a replay that served the wrong
recorded frame is visible in the output rather than only in a count.
"""

try:
    from mcp.server.mcpserver import MCPServer
except ModuleNotFoundError as error:
    if error.name != "mcp.server.mcpserver":
        raise
    # MCP 1.x used FastMCP; 2.x renamed it to MCPServer.
    from mcp.server.fastmcp import FastMCP as MCPServer

app = MCPServer("agenticreplay-check")


@app.tool()
def lookup(key: str) -> str:
    """Return a canned value for a key."""
    return f"VALUE-FOR-{key}"


if __name__ == "__main__":
    app.run()

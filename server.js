#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import http from "http";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import open from "open";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_FILE = path.join(__dirname, "sessions.json");
const REVIEWER_HTML_PATH = path.join(__dirname, "src", "reviewer.html");
const DEFAULT_PORT = 3456;

// ===== State Management =====
let sessions = {};
let httpPort = DEFAULT_PORT;

async function loadSessions() {
  try {
    const data = await fs.readFile(SESSIONS_FILE, "utf-8");
    sessions = JSON.parse(data);
  } catch {
    sessions = {};
  }
}

async function saveSessions() {
  await fs.writeFile(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

function ensureProjectDir(projectPath) {
  const dir = path.join(projectPath, ".claude", "design-reviews");
  return fs.mkdir(dir, { recursive: true }).then(() => dir);
}

function getDesignPath(projectPath, name) {
  return path.join(projectPath, ".claude", "design-reviews", `${name}.html`);
}

// ===== HTTP Server =====
async function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${httpPort}`);

    // Serve reviewer page
    if (url.pathname === "/" || url.pathname === "/reviewer") {
      try {
        const html = await fs.readFile(REVIEWER_HTML_PATH, "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(500);
        res.end("Reviewer page not found");
      }
      return;
    }

    // Serve design file
    if (url.pathname === "/api/design") {
      const projectPath = url.searchParams.get("project");
      const fileName = url.searchParams.get("file");
      if (!projectPath || !fileName) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing project or file parameter" }));
        return;
      }
      const filePath = getDesignPath(projectPath, fileName);
      try {
        const content = await fs.readFile(filePath, "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Design file not found" }));
      }
      return;
    }

    // Get annotations (read-only)
    if (url.pathname === "/api/annotations" && req.method === "GET") {
      const sessionId = url.searchParams.get("session");
      const session = sessions[sessionId];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          sessionId,
          annotations: session?.annotations || [],
          count: session?.annotations?.length || 0,
        })
      );
      return;
    }

    // Get status
    if (url.pathname === "/api/status" && req.method === "GET") {
      const sessionId = url.searchParams.get("session");
      const session = sessions[sessionId];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          sessionId,
          status: session?.status || "not_found",
          version: session?.version || 0,
          annotationCount: session?.annotations?.length || 0,
        })
      );
      return;
    }

    // Submit annotations
    if (url.pathname === "/api/annotations" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const data = JSON.parse(body);
          const sessionId = data.sessionId;
          if (!sessions[sessionId]) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: "Session not found" }));
            return;
          }
          sessions[sessionId].annotations = data.annotations || [];
          sessions[sessionId].status = "has_annotations";
          sessions[sessionId].submittedAt = new Date().toISOString();
          await saveSessions();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, count: data.annotations.length }));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Approve design
    if (url.pathname === "/api/approve" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const data = JSON.parse(body);
          const sessionId = data.sessionId;
          if (!sessions[sessionId]) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: "Session not found" }));
            return;
          }
          sessions[sessionId].status = "approved";
          sessions[sessionId].approvedAt = new Date().toISOString();
          await saveSessions();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      server
        .listen(port, () => {
          httpPort = port;
          console.error(`[DesignReview] HTTP server listening on http://localhost:${port}`);
          resolve(server);
        })
        .on("error", (err) => {
          if (err.code === "EADDRINUSE") {
            tryPort(port + 1);
          } else {
            reject(err);
          }
        });
    };
    tryPort(DEFAULT_PORT);
  });
}

// ===== MCP Server =====
const server = new Server(
  {
    name: "design-review",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "save_design",
        description:
          "Save a design proposal HTML file to the project's .claude/design-reviews/ directory. Creates the directory if it doesn't exist.",
        inputSchema: {
          type: "object",
          properties: {
            projectPath: {
              type: "string",
              description: "Absolute path to the project root directory",
            },
            html: {
              type: "string",
              description: "The complete HTML content of the design proposal",
            },
            name: {
              type: "string",
              description: "Base name for the design file (e.g., 'auth-flow-v1')",
            },
          },
          required: ["projectPath", "html", "name"],
        },
      },
      {
        name: "start_review",
        description:
          "Start a design review session. Opens the browser with the review page for the specified design file. Creates a new session for tracking annotations.",
        inputSchema: {
          type: "object",
          properties: {
            projectPath: {
              type: "string",
              description: "Absolute path to the project root directory",
            },
            designName: {
              type: "string",
              description: "Name of the design file without .html extension",
            },
            sessionId: {
              type: "string",
              description:
                "Unique session ID for this review round (e.g., 'proj-auth-v1')",
            },
          },
          required: ["projectPath", "designName", "sessionId"],
        },
      },
      {
        name: "check_status",
        description:
          "Check the current status of a review session. Returns: pending (waiting for annotations), has_annotations (user submitted feedback), approved (user confirmed the design).",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "The review session ID",
            },
          },
          required: ["sessionId"],
        },
      },
      {
        name: "get_annotations",
        description:
          "Get all annotations submitted for a review session. Returns empty array if no annotations yet. After retrieving, the session status resets to 'pending' to allow new annotation rounds.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "The review session ID",
            },
          },
          required: ["sessionId"],
        },
      },
      {
        name: "wait_for_annotations",
        description:
          "BLOCKING: Wait for the user to submit annotations or approve the design in the browser. Polls internally for up to 300 seconds (5 minutes). Returns ANNOTATIONS, APPROVED, or TIMEOUT. If TIMEOUT, the caller should automatically call this tool again to continue waiting (auto-refill).",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "The review session ID",
            },
            timeout: {
              type: "number",
              description: "Wait seconds. Default 300, max 300.",
            },
          },
          required: ["sessionId"],
        },
      },
      {
        name: "approve_design",
        description:
          "Mark a design review session as approved. This indicates the user is satisfied with the design and you can proceed to code implementation.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "The review session ID",
            },
          },
          required: ["sessionId"],
        },
      },
      {
        name: "list_sessions",
        description:
          "List all active review sessions with their current status.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "save_design": {
      const { projectPath, html, name: designName } = args;
      await ensureProjectDir(projectPath);
      const filePath = getDesignPath(projectPath, designName);
      await fs.writeFile(filePath, html, "utf-8");
      return {
        content: [
          {
            type: "text",
            text: `Design saved to ${filePath}`,
          },
        ],
      };
    }

    case "start_review": {
      const { projectPath, designName, sessionId } = args;
      const designPath = getDesignPath(projectPath, designName);
      try {
        await fs.access(designPath);
      } catch {
        return {
          content: [
            {
              type: "text",
              text: `Error: Design file not found at ${designPath}. Call save_design first.`,
            },
          ],
          isError: true,
        };
      }

      sessions[sessionId] = {
        sessionId,
        projectPath,
        designName,
        status: "pending",
        version: 1,
        annotations: [],
        createdAt: new Date().toISOString(),
      };
      await saveSessions();

      const reviewUrl = `http://localhost:${httpPort}/reviewer?project=${encodeURIComponent(
        projectPath
      )}&file=${encodeURIComponent(designName)}&session=${encodeURIComponent(
        sessionId
      )}`;

      try {
        await open(reviewUrl);
      } catch (err) {
        console.error("[DesignReview] Failed to open browser:", err.message);
      }

      return {
        content: [
          {
            type: "text",
            text: `Review session started: ${sessionId}\nReview page: ${reviewUrl}\nStatus: pending (waiting for annotations)`,
          },
        ],
      };
    }

    case "check_status": {
      const { sessionId } = args;
      const session = sessions[sessionId];
      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: `Session not found: ${sessionId}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Session: ${sessionId}\nStatus: ${session.status}\nVersion: ${session.version}\nAnnotations: ${session.annotations?.length || 0}`,
          },
        ],
      };
    }

    case "get_annotations": {
      const { sessionId } = args;
      const session = sessions[sessionId];
      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: `Session not found: ${sessionId}`,
            },
          ],
          isError: true,
        };
      }
      const annotations = session.annotations || [];
      // Reset status to pending after retrieval, allowing new rounds
      if (session.status === "has_annotations") {
        session.status = "pending";
        session.annotations = [];
        await saveSessions();
      }
      return {
        content: [
          {
            type: "text",
            text:
              annotations.length === 0
                ? "No annotations yet."
                : `Retrieved ${annotations.length} annotation(s):\n\n${JSON.stringify(
                    annotations,
                    null,
                    2
                  )}`,
          },
        ],
      };
    }

    case "wait_for_annotations": {
      const { sessionId, timeout = 300 } = args;
      const maxWaitMs = Math.min(timeout * 1000, 300 * 1000);
      const pollInterval = 1000;
      let elapsed = 0;

      while (elapsed < maxWaitMs) {
        await loadSessions();
        const session = sessions[sessionId];

        if (!session) {
          return {
            content: [
              {
                type: "text",
                text: `Session not found: ${sessionId}`,
              },
            ],
            isError: true,
          };
        }

        if (session.status === "has_annotations") {
          const annotations = session.annotations || [];
          session.status = "pending";
          session.annotations = [];
          await saveSessions();
          return {
            content: [
              {
                type: "text",
                text: `ANNOTATIONS:${JSON.stringify(annotations)}`,
              },
            ],
          };
        }

        if (session.status === "approved") {
          return {
            content: [
              {
                type: "text",
                text: "APPROVED",
              },
            ],
          };
        }

        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        elapsed += pollInterval;
      }

      await loadSessions();
      const finalSession = sessions[sessionId];
      return {
        content: [
          {
            type: "text",
            text: `TIMEOUT: Waited ${maxWaitMs / 1000}s. Current status: ${finalSession?.status || "unknown"}. Automatically call wait_for_annotations again to continue waiting.`,
          },
        ],
      };
    }

    case "approve_design": {
      const { sessionId } = args;
      const session = sessions[sessionId];
      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: `Session not found: ${sessionId}`,
            },
          ],
          isError: true,
        };
      }
      session.status = "approved";
      session.approvedAt = new Date().toISOString();
      await saveSessions();
      return {
        content: [
          {
            type: "text",
            text: `Design approved for session: ${sessionId}. You can now proceed to code implementation.`,
          },
        ],
      };
    }

    case "list_sessions": {
      const list = Object.values(sessions).map((s) => ({
        sessionId: s.sessionId,
        status: s.status,
        version: s.version,
        designName: s.designName,
        createdAt: s.createdAt,
      }));
      return {
        content: [
          {
            type: "text",
            text:
              list.length === 0
                ? "No active sessions."
                : `Active sessions:\n\n${JSON.stringify(list, null, 2)}`,
          },
        ],
      };
    }

    default:
      return {
        content: [
          {
            type: "text",
            text: `Unknown tool: ${name}`,
          },
        ],
        isError: true,
      };
  }
});

// ===== Main =====
async function main() {
  await loadSessions();
  await startHttpServer();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[DesignReview] MCP Server running on stdio");
}

main().catch((err) => {
  console.error("[DesignReview] Fatal error:", err);
  process.exit(1);
});

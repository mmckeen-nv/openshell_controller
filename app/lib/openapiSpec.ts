export function buildOpenApiSpec(baseUrl = "") {
  const serverUrl = baseUrl || "http://localhost:3000"

  return {
    openapi: "3.1.0",
    info: {
      title: "OpenShell Control API",
      version: "0.1.0",
      description: "Controller-node deployment and registry APIs for OpenShell Control.",
    },
    servers: [
      {
        url: serverUrl,
        description: "Current OpenShell Control instance",
      },
    ],
    security: [{ sessionCookie: [] }],
    tags: [
      {
        name: "Controller Nodes",
        description: "Plan, deploy, register, and rename remote OpenShell Control controller nodes.",
      },
    ],
    paths: {
      "/api/controller-node/plan": {
        post: {
          tags: ["Controller Nodes"],
          summary: "Generate a remote controller-node launch kit",
          description: "Builds a bootstrap script, environment block, systemd unit, and readiness checks for a remote controller node. The generated node is also registered locally.",
          operationId: "createControllerNodePlan",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ControllerPlanRequest" },
                examples: {
                  manual: {
                    summary: "Manual deploy plan",
                    value: {
                      controllerName: "remote-controller-01",
                      controllerHost: "203.0.113.10",
                      sshTarget: "ubuntu@203.0.113.10",
                      installDir: "/opt/openshell-control",
                      repoUrl: "https://github.com/mmckeen-nv/openshell_controller.git",
                      dashboardPort: 3000,
                      terminalPort: 3011,
                      openClawDashboardUrl: "http://127.0.0.1:18789/",
                      openshellGateway: "nemoclaw",
                      parentControllerUrl: "http://localhost:3100",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Launch kit generated",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ControllerPlanResponse" },
                },
              },
            },
            "400": { $ref: "#/components/responses/BadRequest" },
            "401": { $ref: "#/components/responses/Unauthorized" },
          },
        },
      },
      "/api/controller-node/deploy": {
        post: {
          tags: ["Controller Nodes"],
          summary: "Autodeploy a controller node over SSH",
          description: "Connects to a VPS over SSH, optionally elevates with sudo, runs the generated bootstrap, and registers the node locally. The remote password is used once and is not persisted.",
          operationId: "autodeployControllerNode",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ControllerDeployRequest" },
                examples: {
                  sudo: {
                    summary: "Autodeploy with sudo and pinned host key",
                    value: {
                      controllerName: "remote-controller-01",
                      controllerHost: "203.0.113.10",
                      parentControllerUrl: "http://localhost:3100",
                      remoteHost: "203.0.113.10",
                      remotePort: 22,
                      remoteUser: "ubuntu",
                      remotePassword: "one-time-password",
                      allowSudo: true,
                      expectedHostKeySha256: "SHA256:replace-with-remote-host-fingerprint",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Remote deploy completed",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ControllerDeployResponse" },
                },
              },
            },
            "400": { $ref: "#/components/responses/BadRequest" },
            "401": { $ref: "#/components/responses/Unauthorized" },
          },
        },
      },
      "/api/controller-node/registry": {
        get: {
          tags: ["Controller Nodes"],
          summary: "List managed controller nodes",
          operationId: "listControllerNodes",
          responses: {
            "200": {
              description: "Managed nodes",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      nodes: {
                        type: "array",
                        items: { $ref: "#/components/schemas/ControllerNode" },
                      },
                    },
                    required: ["nodes"],
                  },
                },
              },
            },
            "401": { $ref: "#/components/responses/Unauthorized" },
          },
        },
        post: {
          tags: ["Controller Nodes"],
          summary: "Register or rename a controller node",
          description: "Upserts a controller node, or renames an existing node when action is rename.",
          operationId: "updateControllerNodeRegistry",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ControllerRegistryRequest" },
                examples: {
                  rename: {
                    summary: "Rename a node",
                    value: {
                      action: "rename",
                      nodeId: "remote-controller-01",
                      name: "Lab VPS East",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Registry updated",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      node: { $ref: "#/components/schemas/ControllerNode" },
                      nodes: {
                        type: "array",
                        items: { $ref: "#/components/schemas/ControllerNode" },
                      },
                    },
                    required: ["node", "nodes"],
                  },
                },
              },
            },
            "400": { $ref: "#/components/responses/BadRequest" },
            "401": { $ref: "#/components/responses/Unauthorized" },
          },
        },
      },
      "/api/openapi": {
        get: {
          tags: ["Controller Nodes"],
          summary: "Fetch the OpenAPI document",
          operationId: "getOpenApiSpec",
          responses: {
            "200": {
              description: "OpenAPI 3.1 document",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: true,
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: process.env.OPENSHELL_CONTROL_COOKIE_NAME || "openshell_control_session",
        },
      },
      responses: {
        BadRequest: {
          description: "Invalid request",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        Unauthorized: {
          description: "Authentication required",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
      schemas: {
        ErrorResponse: {
          type: "object",
          properties: {
            ok: { type: "boolean", example: false },
            error: { type: "string" },
          },
          required: ["error"],
        },
        ControllerNode: {
          type: "object",
          properties: {
            id: { type: "string", example: "remote-controller-01" },
            name: { type: "string", example: "Lab VPS East" },
            host: { type: "string", example: "203.0.113.10" },
            url: { type: "string", format: "uri", example: "http://203.0.113.10:3000" },
            role: { type: "string", enum: ["local", "controller-node"] },
            status: { type: "string", enum: ["local", "configured"] },
            updatedAt: { type: "string", format: "date-time" },
          },
          required: ["id", "name", "host", "url", "role", "status", "updatedAt"],
        },
        ControllerPlanRequest: {
          type: "object",
          properties: {
            controllerName: { type: "string", example: "remote-controller-01" },
            controllerHost: { type: "string", example: "203.0.113.10" },
            sshTarget: { type: "string", example: "ubuntu@203.0.113.10" },
            installDir: { type: "string", example: "/opt/openshell-control" },
            repoUrl: { type: "string", example: "https://github.com/mmckeen-nv/openshell_controller.git" },
            dashboardPort: { type: "integer", minimum: 1, maximum: 65535, example: 3000 },
            terminalPort: { type: "integer", minimum: 1, maximum: 65535, example: 3011 },
            openClawDashboardUrl: { type: "string", format: "uri", example: "http://127.0.0.1:18789/" },
            openshellGateway: { type: "string", example: "nemoclaw" },
            parentControllerUrl: { type: "string", format: "uri", example: "http://localhost:3100" },
            existingToken: { type: "string", description: "Optional existing controller shared secret." },
          },
          required: ["controllerHost"],
        },
        ControllerDeployRequest: {
          allOf: [
            { $ref: "#/components/schemas/ControllerPlanRequest" },
            {
              type: "object",
              properties: {
                remoteHost: { type: "string", example: "203.0.113.10" },
                remotePort: { type: "integer", minimum: 1, maximum: 65535, example: 22 },
                remoteUser: { type: "string", example: "ubuntu" },
                remotePassword: { type: "string", format: "password" },
                allowSudo: { type: "boolean", default: false },
                acceptUnknownHostKey: { type: "boolean", default: false },
                expectedHostKeySha256: { type: "string", example: "SHA256:replace-with-remote-host-fingerprint" },
              },
              required: ["remoteUser", "remotePassword"],
            },
          ],
        },
        ControllerPlanResponse: {
          type: "object",
          properties: {
            ok: { type: "boolean", example: true },
            controller: {
              type: "object",
              additionalProperties: true,
            },
            env: { type: "string" },
            serviceUnit: { type: "string" },
            commands: {
              type: "object",
              properties: {
                ssh: { type: "string" },
                localBootstrap: { type: "string" },
                start: { type: "string" },
                terminal: { type: "string" },
              },
              required: ["ssh", "localBootstrap", "start", "terminal"],
            },
            checks: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["ok", "controller", "env", "serviceUnit", "commands", "checks"],
        },
        ControllerDeployResponse: {
          allOf: [
            { $ref: "#/components/schemas/ControllerPlanResponse" },
            {
              type: "object",
              properties: {
                hostKeySha256: { type: ["string", "null"] },
                stdout: { type: "string" },
                stderr: { type: "string" },
                note: { type: "string" },
              },
              required: ["hostKeySha256", "stdout", "stderr", "note"],
            },
          ],
        },
        ControllerRegistryRequest: {
          oneOf: [
            {
              type: "object",
              properties: {
                action: { type: "string", const: "rename" },
                nodeId: { type: "string" },
                name: { type: "string" },
              },
              required: ["action", "nodeId", "name"],
            },
            {
              type: "object",
              properties: {
                action: { type: "string", const: "upsert" },
                id: { type: "string" },
                name: { type: "string" },
                host: { type: "string" },
                url: { type: "string", format: "uri" },
                role: { type: "string", enum: ["local", "controller-node"] },
              },
              required: ["host", "url"],
            },
          ],
        },
      },
    },
  }
}

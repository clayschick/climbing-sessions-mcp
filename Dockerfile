FROM node:20-alpine
WORKDIR /app
COPY package.json .
COPY mcp-server.js ./mcp-server.mjs
EXPOSE 3000
CMD ["node", "mcp-server.mjs"]

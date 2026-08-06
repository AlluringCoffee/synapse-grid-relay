# Optional container build for the Synapse Grid relay.
# Works on Fly.io, Railway, Render (Docker), or your own VPS.
#   docker build -t synapse-grid-relay .
#   docker run -p 8080:8080 synapse-grid-relay
FROM node:20-alpine

WORKDIR /app

# Install deps first for layer caching. package-lock.json is optional.
COPY package*.json ./
RUN npm install --omit=dev

COPY signaling_server.js ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "signaling_server.js"]

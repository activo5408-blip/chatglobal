FROM node:22-alpine
WORKDIR /app
COPY server.js package.json ./
USER node
ENV PORT=8443
EXPOSE 8443
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8443/health || exit 1
CMD ["node", "server.js"]

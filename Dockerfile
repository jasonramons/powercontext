FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json README.md server.mjs ./
COPY lib ./lib
COPY bridge ./bridge
COPY data ./data
COPY web ./web
COPY docs ./docs
EXPOSE 8080
CMD ["node", "server.mjs"]

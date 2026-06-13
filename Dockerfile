FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
RUN mkdir -p /data /app/public/uploads
EXPOSE 3000
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/pwa-manager.db
CMD ["node", "server.js"]

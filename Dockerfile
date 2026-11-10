FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV SESSION_DIR=/data/session DB_FILE=/data/db.json STORE_DIR=/data/store DATA_DIR=/data
CMD ["node", "telegram.js"]

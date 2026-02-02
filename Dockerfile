FROM node:18-slim

WORKDIR /app

COPY package.json ./

# ⛔ MATIKAN SCRIPT prepare (husky, build internal)
RUN npm install --force --ignore-scripts

COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.js"]

FROM node:18

WORKDIR /app

# Install Chromium dependencies
RUN apt-get update && apt-get install -y \
  chromium \
  libnss3 \
  libatk-bridge2.0-0 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  libgbm1 \
  libasound2 \
  libpangocairo-1.0-0 \
  libatk1.0-0 \
  libcups2 \
  libxshmfence1 \
  libgtk-3-0 \
  fonts-liberation \
  --no-install-recommends && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --force --ignore-scripts

COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.js"]

FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN node node_modules/playwright/cli.js install chromium

CMD ["node", "index.js"]
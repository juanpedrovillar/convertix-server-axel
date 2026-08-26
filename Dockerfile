FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY server.js .
COPY dashboard.html .
COPY landing.html .
COPY naomi.jpg .
COPY naomi.webp .
EXPOSE ${PORT:-3000}
CMD ["node", "server.js"]

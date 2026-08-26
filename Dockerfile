FROM node:20-alpine
WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

# Copia todo el proyecto. Antes se listaban los archivos uno por uno y cada
# archivo nuevo quedaba afuera del contenedor sin que nadie se enterara.
COPY . .

EXPOSE ${PORT:-3000}
CMD ["node", "server.js"]

FROM node:22.12-alpine3.20
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build && mkdir -p dist/database/migrations && cp src/database/migrations/*.sql dist/database/migrations/
EXPOSE 3000
CMD ["npm","start"]

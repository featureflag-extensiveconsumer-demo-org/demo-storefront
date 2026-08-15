FROM node:24-alpine
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY app.mjs traffic.mjs ./
USER node
CMD ["npm", "run", "traffic"]

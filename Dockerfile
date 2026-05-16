FROM node:20.10.0-alpine3.19 as build

WORKDIR /home/live2ai

COPY . .

RUN npm install --legacy-peer-deps && \
    npm run build

FROM node:20.10.0-alpine3.19 as runner

RUN adduser -D -u 1001 -h /home/live2ai live2ai

COPY --chown=1001:1001 --from=build /home/live2ai /home/live2ai

WORKDIR /home/live2ai

# Make the start script executable
RUN chmod +x start.sh

USER live2ai

EXPOSE 3000

ENTRYPOINT ["./start.sh"]
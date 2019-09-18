FROM alpine:latest
RUN apk add --no-cache nodejs npm yarn zip
WORKDIR /app

COPY ./package.json /app

RUN yarn

COPY ./src /app/src

CMD [ "yarn", "server"]

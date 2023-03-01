FROM public.ecr.aws/docker/library/node:latest

ENV TINI_VERSION v0.19.0
ADD https://github.com/krallin/tini/releases/download/${TINI_VERSION}/tini /tini
RUN chmod +x /tini

WORKDIR /workdir
COPY package.json index.mjs ./
RUN npm i

ENTRYPOINT ["/tini", "--"]
CMD ["node", "index.mjs"]
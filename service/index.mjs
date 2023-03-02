import express from 'express';
import morgan from 'morgan';

const port = process.env.SERVER_PORT | 3000;

const app = express();
app.use(morgan(`combined`));

app.get('/health', (req, res) => {
    res.status(200).send(JSON.stringify({ status: 'OK' }, null, 4));
});
app.get('/dump', (req, res) => {
    res.status(200).setHeader('Content-Type', 'text/plain').send(JSON.stringify({
        path: req.url,
        headers: req.headers,
        env: process.env,
    }, null, 4));
});

const server = app.listen(port, '0.0.0.0', () => {
    console.log(`start at ${port}`);
});
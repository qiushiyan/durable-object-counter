import { DurableObject } from "cloudflare:workers";
import { Env, Hono } from "hono";
import { cors } from "hono/cors";
const app = new Hono<{ Bindings: CloudflareBindings }>();

app.use(
	"*",
	cors({
		origin: [
			"https://qiushiyan.dev",
			"http://localhost:3000",
			"http://localhost:8788",
		],
	}),
);

app.use("*", async (c, next) => {
	const ip = c.req.header("CF-Connecting-IP") || "global";
	const limiterId = c.env.LIMITER.idFromName(ip);
	const limiterStub = c.env.LIMITER.get(limiterId);

	const millisecondsToNextRequest = await limiterStub.checkRateLimit();

	if (millisecondsToNextRequest > 0) {
		return c.json(
			{
				error: "Rate limit exceeded",
				retryAfter: millisecondsToNextRequest / 1000,
			},
			429,
		);
	}

	await limiterStub.recordRequest();
	await next();
});

app.get("/:name/value", async (c) => {
	const id = c.env.COUNTER.idFromName(c.req.param("name"));
	const obj = c.env.COUNTER.get(id);

	const value = await obj.getCounterValue();
	return c.json({ value });
});

app.post("/:name/increment", async (c) => {
	const id = c.env.COUNTER.idFromName(c.req.param("name"));
	const obj = c.env.COUNTER.get(id);

	const value = await obj.increment();
	return c.json({ value });
});

app.post("/:name/decrement", async (c) => {
	const id = c.env.COUNTER.idFromName(c.req.param("name"));
	const obj = c.env.COUNTER.get(id);

	const value = await obj.decrement();
	return c.json({ value });
});

export class Counter extends DurableObject {
	async getCounterValue() {
		const value = (await this.ctx.storage.get<number>("value")) || 0;
		return value;
	}

	async increment(amount = 1) {
		let value = (await this.ctx.storage.get<number>("value")) || 0;
		value += amount;
		await this.ctx.storage.put("value", value);
		return value;
	}

	async decrement(amount = 1) {
		let value = (await this.ctx.storage.get<number>("value")) || 0;
		value -= amount;
		await this.ctx.storage.put("value", value);
		return value;
	}
}

// user have to wait 0.5s before they can make another request, if they make more requests during this time, the wait time will be increased exponentially
const BASE_WAIT_TIME = 500;
// the maximum wait time is 30 seconds
const MAX_WAIT_TIME = 30000;
// user can make arbitrary number of requests in the first 3 seconds
const GRACE_PERIOD = 3000;

export class Limiter extends DurableObject {
	private nextAllowedTime: number;
	private consecutiveHits: number;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.nextAllowedTime = 0;
		this.consecutiveHits = 0;
	}

	async checkRateLimit() {
		const now = Date.now();

		if (now >= this.nextAllowedTime) {
			return 0; // Request is allowed
		}

		return Math.max(0, this.nextAllowedTime - now - GRACE_PERIOD);
	}

	async recordRequest() {
		const now = Date.now();

		if (now >= this.nextAllowedTime) {
			this.consecutiveHits = 0;
			this.nextAllowedTime = now + BASE_WAIT_TIME;
		} else {
			this.consecutiveHits++;
			const waitTime = Math.min(
				BASE_WAIT_TIME * 2 ** (this.consecutiveHits - 1),
				MAX_WAIT_TIME,
			);
			this.nextAllowedTime = Math.max(this.nextAllowedTime, now + waitTime);
		}
	}
}

export default app;

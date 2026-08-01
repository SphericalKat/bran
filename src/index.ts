import { Bot, webhookCallback } from 'grammy';

/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
export { ReviewerAgent } from './agents/reviewer';

export interface Env {
	TELEGRAM_BOT_TOKEN: string;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
		bot.command('start', async (ctx) => {
			await ctx.reply('Started.');
		});

		bot.command('review', async (ctx) => {
			const arg = ctx.match;

		})

		return webhookCallback(bot, 'cloudflare-mod')(request);
	},
} satisfies ExportedHandler<Env>;

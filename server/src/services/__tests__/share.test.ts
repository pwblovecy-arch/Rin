import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ShareService } from '../share';
import { Hono } from "hono";
import type { Variables } from "../../core/hono-types";
import { setupTestApp, cleanupTestDB } from '../../../tests/fixtures';
import type { Database } from 'bun:sqlite';

describe('ShareService', () => {
    let env: Env;
    let app: Hono<{ Bindings: Env; Variables: Variables }>;
    let sqlite: Database;

    beforeEach(async () => {
        const ctx = await setupTestApp(ShareService);
        env = ctx.env;
        app = ctx.app;
        sqlite = ctx.sqlite;
        await seedTestData(sqlite);
    });

    afterEach(() => {
        cleanupTestDB(sqlite);
    });

    async function seedTestData(sqlite: Database) {
        sqlite.exec(`
            INSERT INTO users (id, username, avatar, openid) VALUES (1, 'testuser', 'avatar.png', 'gh_test')
        `);
        sqlite.exec(`
            INSERT INTO feeds (id, title, content, summary, uid, draft, listed, created_at, updated_at) VALUES
                (1, 'My First Post', '<div><img src="https://example.com/cover.jpg" /></div><p>body</p>', 'Short summary here', 1, 0, 1, unixepoch(), unixepoch()),
                (2, 'Aliased Post', '<p>no image</p>', 'Alias summary', 1, 0, 1, unixepoch(), unixepoch()),
                (3, 'Draft Post', '<p>draft</p>', 'draft summary', 1, 1, 1, unixepoch(), unixepoch())
        `);
        sqlite.exec(`UPDATE feeds SET alias = 'hello-world' WHERE id = 2`);
    }

    it('returns HTML with Open Graph metadata for an article', async () => {
        const res = await app.request('/1', { method: 'GET' }, env);
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toContain('text/html');

        const html = await res.text();
        expect(html).toContain('og:title');
        expect(html).toContain('My First Post');
        expect(html).toContain('Short summary here');
        expect(html).toContain('og:image');
        expect(html).toContain('https://example.com/cover.jpg');
    });

    it('sets canonical and og:url to the frontend article page', async () => {
        const res = await app.request('/1', { method: 'GET' }, env);
        const html = await res.text();
        expect(html).toContain('rel="canonical"');
        expect(html).toContain('/feed/1');
    });

    it('resolves an article by alias', async () => {
        const res = await app.request('/hello-world', { method: 'GET' }, env);
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain('Aliased Post');
        expect(html).toContain('Alias summary');
    });

    it('does not expose draft articles', async () => {
        const res = await app.request('/3', { method: 'GET' }, env);
        // 草稿不可分享：应重定向回首页而不是渲染
        expect(res.status).toBe(302);
    });

    it('redirects to the homepage for unknown ids', async () => {
        const res = await app.request('/99999', { method: 'GET' }, env);
        expect(res.status).toBe(302);
    });

    it('falls back to the default og image when the article has no image', async () => {
        const res = await app.request('/2', { method: 'GET' }, env);
        const html = await res.text();
        expect(html).toContain('og-image.jpg');
    });

    it('escapes HTML special characters in the title', async () => {
        sqlite.exec(`
            INSERT INTO feeds (id, title, content, summary, uid, draft, listed, created_at, updated_at)
            VALUES (42, 'A "quoted" <title> & more', '<p>x</p>', 'sum', 1, 0, 1, unixepoch(), unixepoch())
        `);
        const res = await app.request('/42', { method: 'GET' }, env);
        const html = await res.text();
        expect(html).toContain('&quot;quoted&quot;');
        expect(html).toContain('&lt;title&gt;');
        expect(html).toContain('&amp;');
        // 不应出现未转义的注入内容
        expect(html).not.toContain('<title>A "quoted"');
    });

    it('truncates very long summaries', async () => {
        const longSummary = 'x'.repeat(600);
        sqlite.exec(`
            INSERT INTO feeds (id, title, content, summary, uid, draft, listed, created_at, updated_at)
            VALUES (43, 'Long', '<p>x</p>', '${longSummary}', 1, 0, 1, unixepoch(), unixepoch())
        `);
        const res = await app.request('/43', { method: 'GET' }, env);
        const html = await res.text();
        const m = html.match(/og:description" content="([^"]*)"/);
        expect(m).not.toBeNull();
        expect((m as RegExpMatchArray)[1].length).toBeLessThanOrEqual(300);
    });

    it('includes a meta refresh fallback for real browsers', async () => {
        const res = await app.request('/1', { method: 'GET' }, env);
        const html = await res.text();
        expect(html).toContain('http-equiv="refresh"');
        expect(html).toContain('location.replace');
    });
});

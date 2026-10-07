/** A tiny Discourse for tests: /categories.json answers only to the right Api-Key and Api-Username. */
export const KEY = 'DISCOURSE-KEY-123';
export const USER = 'alice';

export class FakeDiscourse {
  readonly log: string[] = [];
  private server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      this.log.push(path);
      if (path !== '/categories.json') return new Response('{}', { status: 404 });
      if (req.headers.get('Api-Key') !== KEY || req.headers.get('Api-Username') !== USER) {
        return Response.json({ errors: ['You are not permitted to view the requested resource.'] }, { status: 401 });
      }
      return Response.json({ category_list: { categories: [] } });
    },
  });

  get url(): string { return `http://127.0.0.1:${this.server.port}`; }
  stop(): void { this.server.stop(true); }
}

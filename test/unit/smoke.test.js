const { boot, client, toS4, S5 } = require('../support/harness');

describe('smoke', () => {
  it('boots and runs to S5', async () => {
    const h = await boot();
    const c = client(h.base);
    await toS4(c, h.ctx);
    const r = await c.transform('작은 것부터 해봐');
    expect(r.status).toBe(202);
    const v = await c.waitTransform(h.ctx);
    expect(v.body.current_step).toBe('S5');
    const s5 = await c.step('S5', S5);
    expect(s5.body.next_step).toBe('S6');
    await h.stop();
  });
});

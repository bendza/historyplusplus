import { describe, expect, it, vi } from 'vitest';
import { Backoff, Lru, PriorityGate, Rate, TimeoutError, clipText, nextBatchSize, pauseAfter, planBatches, withTimeout } from './sched';

describe('Backoff', () => {
  it('doubles up to the cap and resets', () => {
    const b = new Backoff(1000, 5000);
    expect([b.fail(), b.fail(), b.fail(), b.fail(), b.fail()]).toEqual([1000, 2000, 4000, 5000, 5000]);
    expect(b.count).toBe(5);
    b.reset();
    expect(b.fail()).toBe(1000);
  });
});

describe('PriorityGate', () => {
  it('idle resolves immediately when nothing holds the gate', async () => {
    const g = new PriorityGate();
    await expect(g.idle()).resolves.toBeUndefined();
  });

  it('idle waits until the last holder leaves', async () => {
    const g = new PriorityGate();
    g.enter();
    g.enter();
    let done = false;
    const p = g.idle().then(() => (done = true));
    g.leave();
    await Promise.resolve();
    expect(done).toBe(false);
    g.leave();
    await p;
    expect(done).toBe(true);
    expect(g.busy).toBe(false);
  });

  it('run releases the gate even on error', async () => {
    const g = new PriorityGate();
    await expect(g.run(async () => { expect(g.busy).toBe(true); throw new Error('x'); })).rejects.toThrow('x');
    expect(g.busy).toBe(false);
  });

  it('extra leave() does not go negative', () => {
    const g = new PriorityGate();
    g.leave();
    g.enter();
    expect(g.busy).toBe(true);
  });
});

describe('planBatches', () => {
  it('groups by length, covers every index once', () => {
    const lengths = [50, 10, 40, 20, 30];
    const b = planBatches(lengths, 2);
    expect(b).toEqual([[1, 3], [4, 2], [0]]);
    expect(b.flat().sort()).toEqual([0, 1, 2, 3, 4]);
  });
  it('handles empty input and silly batch sizes', () => {
    expect(planBatches([], 8)).toEqual([]);
    expect(planBatches([1, 2], 0)).toEqual([[0], [1]]);
  });
});

describe('nextBatchSize / pauseAfter', () => {
  it('starts small when the rate is unknown and adapts to the target time', () => {
    expect(nextBatchSize(0, 400)).toBe(1);
    expect(nextBatchSize(50, 400)).toBe(8);
    expect(nextBatchSize(1, 400)).toBe(16);
    expect(nextBatchSize(1000, 400)).toBe(1);
  });
  it('clamps the pause between batches', () => {
    expect(pauseAfter(10)).toBe(50);
    expect(pauseAfter(400)).toBe(100);
    expect(pauseAfter(10_000)).toBe(200);
  });
});

describe('clipText', () => {
  it('keeps short text and cuts long text', () => {
    expect(clipText('abc', 5)).toBe('abc');
    expect(clipText('abcdefgh', 5)).toBe('abcde');
  });
});

describe('withTimeout', () => {
  it('passes through results and errors', async () => {
    await expect(withTimeout(Promise.resolve(1), 100)).resolves.toBe(1);
    await expect(withTimeout(Promise.reject(new Error('no')), 100)).rejects.toThrow('no');
  });
  it('rejects with TimeoutError when too slow', async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise(() => {}), 1500);
    vi.advanceTimersByTime(1500);
    await expect(p).rejects.toBeInstanceOf(TimeoutError);
    vi.useRealTimers();
  });
});

describe('Lru', () => {
  it('evicts the least recently used entry', () => {
    const l = new Lru<string, number>(2);
    l.set('a', 1);
    l.set('b', 2);
    l.get('a');
    l.set('c', 3);
    expect(l.get('b')).toBeUndefined();
    expect(l.get('a')).toBe(1);
    expect(l.get('c')).toBe(3);
  });
});

describe('Rate', () => {
  it('averages items per second', () => {
    const r = new Rate(0.5);
    expect(r.perSecond).toBeUndefined();
    r.add(10, 1000);
    expect(r.perSecond).toBe(10);
    r.add(30, 1000);
    expect(r.perSecond).toBe(20);
    r.add(0, 0);
    expect(r.perSecond).toBe(20);
  });
});

/**
 * Antrean tugas agen untuk Joko.
 * - Satu tugas berjalan dalam satu waktu; permintaan lain MENGANTRE (tidak dibuang).
 * - Batas jumlah antrean total & per chat agar satu orang tidak bisa membanjiri.
 * - Setiap tugas punya batas waktu keras, sehingga satu tugas macet tidak pernah
 *   menghentikan antrean.
 */
export function createAgentQueue({ maxQueue = 10, maxPerChat = 3, hardLimitMs = 12 * 60 * 1000, makeTimeoutError } = {}) {
  const queue = [];
  let active = null;

  function enqueue({ label, chatId = null, run }) {
    if (queue.length >= maxQueue) return { accepted: false, reason: 'full' };
    if (chatId && queue.filter(t => t.chatId === chatId).length >= maxPerChat) {
      return { accepted: false, reason: 'chat_limit' };
    }
    let resolve;
    let reject;
    const done = new Promise((res, rej) => { resolve = res; reject = rej; });
    done.catch(() => {}); // cegah unhandled rejection bila pemanggil tidak menunggu hasil
    const ahead = queue.length + (active ? 1 : 0);
    queue.push({ label, chatId, run, resolve, reject });
    setImmediate(drain);
    return { accepted: true, ahead, done };
  }

  async function drain() {
    if (active) return;
    const task = queue.shift();
    if (!task) return;

    active = { label: task.label, chatId: task.chatId, startedAt: Date.now() };
    let timer = null;
    try {
      const result = await Promise.race([
        Promise.resolve().then(task.run),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(makeTimeoutError
            ? makeTimeoutError()
            : new Error('Tugas melebihi batas waktu maksimum dan dilewati.')), hardLimitMs);
        })
      ]);
      task.resolve(result);
    } catch (err) {
      console.error(`[Agent Queue] Tugas "${task.label}" gagal:`, err?.message || err);
      task.reject(err);
    } finally {
      clearTimeout(timer);
      active = null;
      setImmediate(drain);
    }
  }

  function status() {
    return {
      busy: !!active,
      activeLabel: active?.label || null,
      runningForSec: active ? Math.round((Date.now() - active.startedAt) / 1000) : 0,
      pending: queue.length
    };
  }

  return { enqueue, status };
}

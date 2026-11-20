const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = -1;
let lastRandom = new Uint8Array(10);

/**
 * 零依赖单调 ULID 生成器：接受注入的毫秒时间戳，保证在 VirtualClock 同一毫秒内多次生成依然严格字典序递增。
 */
export function ulid(nowMs: number): string {
  const timeChars = new Array<string>(10);
  let t = Math.max(0, Math.floor(nowMs));
  for (let i = 9; i >= 0; i--) {
    timeChars[i] = ENCODING[t % 32];
    t = Math.floor(t / 32);
  }

  if (nowMs === lastTime) {
    // 同一毫秒内单调加 1，防顺序反转
    for (let i = 9; i >= 0; i--) {
      if (lastRandom[i] < 255) {
        lastRandom[i]++;
        break;
      }
      lastRandom[i] = 0;
    }
  } else {
    lastTime = nowMs;
    crypto.getRandomValues(lastRandom);
  }

  // 80 bit 随机数编码为 16 个 Crockford Base32 字符
  const randChars = new Array<string>(16);
  let bitBuffer = 0;
  let bitCount = 0;
  let outIdx = 0;
  for (let i = 0; i < 10; i++) {
    bitBuffer = (bitBuffer << 8) | lastRandom[i];
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      randChars[outIdx++] = ENCODING[(bitBuffer >> bitCount) & 31];
    }
  }

  return timeChars.join("") + randChars.join("");
}

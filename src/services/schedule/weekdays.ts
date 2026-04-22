const NAME_TO_NUM: Record<string, number> = {
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7,
};
const NUM_TO_NAME = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Parse "mon,wed,fri" or "1,3,5" -> sorted unique [1..7]. 1=Mon, 7=Sun. */
export function parseWeekdays(input: string): number[] {
  if (!input) throw new Error('Weekdays is empty');
  const parts = input.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error('Weekdays is empty');
  const set = new Set<number>();
  for (const part of parts) {
    const num = /^\d+$/.test(part) ? parseInt(part, 10) : NAME_TO_NUM[part.toLowerCase()];
    if (num === undefined || num < 1 || num > 7) {
      throw new Error(`Invalid weekday: "${part}" (expected mon..sun or 1..7)`);
    }
    set.add(num);
  }
  return [...set].sort((a, b) => a - b);
}

/** Format [1,3,5] -> "Mon, Wed, Fri". */
export function weekdayNames(nums: number[]): string {
  return nums.map((n) => NUM_TO_NAME[n] ?? String(n)).join(', ');
}

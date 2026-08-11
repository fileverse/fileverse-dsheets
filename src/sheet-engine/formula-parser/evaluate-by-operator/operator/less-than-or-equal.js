import { broadcastCompare } from "./../../helper/array";

export const SYMBOL = "<=";

export default function func(exp1, exp2) {
  return broadcastCompare(exp1, exp2, (a, b) => a <= b);
}

func.SYMBOL = SYMBOL;

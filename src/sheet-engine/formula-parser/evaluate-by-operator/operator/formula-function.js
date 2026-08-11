import * as formulajs from "@fileverse-dev/formulajs";
import SUPPORTED_FORMULAS from "./../../supported-formulas";
import { ERROR_NAME } from "./../../error";
import en from "./../../../core/locale/en";
import CUSTOM_FORMULAS from "./../custom-formulas";

export const SYMBOL = SUPPORTED_FORMULAS;

const FUNCTIONLIST_MAP_EN = (en.functionlist || []).reduce((acc, item) => {
  if (item?.n) {
    acc[item.n.toUpperCase()] = item;
  }
  return acc;
}, Object.create(null));

export default function func(symbol) {
  return function __formulaFunction(...params) {
    symbol = symbol.toUpperCase();

    const symbolParts = symbol.split(".");
    let foundFormula = false;
    let result;

    if (symbolParts.length === 1) {
      if (CUSTOM_FORMULAS[symbolParts[0]]) {
        foundFormula = true;
        result = CUSTOM_FORMULAS[symbolParts[0]](...params);
      } else if (formulajs[symbolParts[0]]) {
        foundFormula = true;
        const functionDetails = FUNCTIONLIST_MAP_EN[symbolParts[0]] || null;
        result = formulajs[symbolParts[0]](...params);
      }
    } else {
      const length = symbolParts.length;
      let index = 0;
      let nestedFormula = formulajs;

      while (index < length) {
        nestedFormula = nestedFormula[symbolParts[index]];
        index++;

        if (!nestedFormula) {
          nestedFormula = null;
          break;
        }
      }
      if (nestedFormula) {
        foundFormula = true;
        const functionDetails = FUNCTIONLIST_MAP_EN[symbolParts[0]] || null;
        result = nestedFormula(...params);
      }
    }

    if (!foundFormula) {
      throw Error(ERROR_NAME);
    }

    return result;
  };
}

func.isFactory = true;
func.SYMBOL = SYMBOL;

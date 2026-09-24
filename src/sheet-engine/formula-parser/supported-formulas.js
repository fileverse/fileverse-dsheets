import * as formulajs from "@fileverse-dev/formulajs";

// Formulas implemented natively in this repo because the upstream formulajs
// fork doesn't (yet) provide them. See custom-formulas.js.
const CUSTOM_FORMULA_NAMES = ["FILTER"];

const SUPPORTED_FORMULAS = [
  ...Object.keys(formulajs),
  ...CUSTOM_FORMULA_NAMES,
];

export default SUPPORTED_FORMULAS;

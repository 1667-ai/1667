const MAX_COMPARE_DIGITS = 64;

type NumberState =
  | "start"
  | "after-minus"
  | "integer-zero"
  | "integer"
  | "decimal-point"
  | "fraction"
  | "exponent"
  | "exponent-sign"
  | "exponent-digits"
  | "invalid";

interface RoundingInterval {
  value: 2 | 3 | 4;
  lower: string;
  upper: string;
}

/** Exact decimal intervals that round to the supported IEEE-754 integers.
 * Endpoints are included because each integer has an even significand. */
const SUPPORTED_INTERVALS: readonly RoundingInterval[] = [
  {
    value: 2,
    lower: "199999999999999988897769753748434595763683319091796875",
    upper: "20000000000000002220446049250313080847263336181640625"
  },
  {
    value: 3,
    lower: "29999999999999997779553950749686919152736663818359375",
    upper: "30000000000000002220446049250313080847263336181640625"
  },
  {
    value: 4,
    lower: "39999999999999997779553950749686919152736663818359375",
    upper: "4000000000000000444089209850062616169452667236328125"
  }
];

/** Constant-memory JSON-number recognizer for a schemaVersion whose parsed
 * JavaScript Number is exactly 2, 3, or 4, including arbitrarily padded forms. */
export class SchemaVersionNumberScanner {
  private state: NumberState = "start";
  private negative = false;
  private mantissaDigits = 0;
  private integerDigits = 0;
  private firstNonZeroIndex: number | null = null;
  private significantDigits = "";
  private discardedNonZero = false;
  private exponentNegative = false;
  private exponentMagnitude = 0;
  private exponentOverflow = false;

  push(byte: number): void {
    const digit = asciiDigit(byte);
    switch (this.state) {
      case "start":
        if (byte === 0x2d) {
          this.negative = true;
          this.state = "after-minus";
        } else {
          this.startInteger(digit);
        }
        return;
      case "after-minus":
        this.startInteger(digit);
        return;
      case "integer-zero":
        if (byte === 0x2e) this.state = "decimal-point";
        else if (byte === 0x65 || byte === 0x45) this.state = "exponent";
        else this.state = "invalid";
        return;
      case "integer":
        if (digit !== null) this.addMantissaDigit(digit, true);
        else if (byte === 0x2e) this.state = "decimal-point";
        else if (byte === 0x65 || byte === 0x45) this.state = "exponent";
        else this.state = "invalid";
        return;
      case "decimal-point":
        if (digit === null) this.state = "invalid";
        else {
          this.addMantissaDigit(digit, false);
          this.state = "fraction";
        }
        return;
      case "fraction":
        if (digit !== null) this.addMantissaDigit(digit, false);
        else if (byte === 0x65 || byte === 0x45) this.state = "exponent";
        else this.state = "invalid";
        return;
      case "exponent":
        if (byte === 0x2b || byte === 0x2d) {
          this.exponentNegative = byte === 0x2d;
          this.state = "exponent-sign";
        } else {
          this.startExponent(digit);
        }
        return;
      case "exponent-sign":
        this.startExponent(digit);
        return;
      case "exponent-digits":
        if (digit === null) this.state = "invalid";
        else this.addExponentDigit(digit);
        return;
      case "invalid":
        return;
    }
  }

  finish(): 2 | 3 | 4 | null {
    if (
      this.negative
      || this.firstNonZeroIndex === null
      || this.exponentOverflow
      || !this.isValid()
    ) return null;

    const implicitExponent = this.integerDigits - this.firstNonZeroIndex - 1;
    const explicitExponent = this.exponentNegative ? -this.exponentMagnitude : this.exponentMagnitude;
    if (explicitExponent !== -implicitExponent) return null;
    for (const interval of SUPPORTED_INTERVALS) {
      if (
        compareSignificands(this.significantDigits, this.discardedNonZero, interval.lower) >= 0
        && compareSignificands(this.significantDigits, this.discardedNonZero, interval.upper) <= 0
      ) return interval.value;
    }
    return null;
  }

  isValid(): boolean {
    return this.state === "integer-zero"
      || this.state === "integer"
      || this.state === "fraction"
      || this.state === "exponent-digits";
  }

  private startInteger(digit: number | null): void {
    if (digit === null) {
      this.state = "invalid";
      return;
    }
    this.addMantissaDigit(digit, true);
    this.state = digit === 0 ? "integer-zero" : "integer";
  }

  private addMantissaDigit(digit: number, integer: boolean): void {
    const index = this.mantissaDigits++;
    if (integer) this.integerDigits += 1;
    if (this.firstNonZeroIndex === null) {
      if (digit === 0) return;
      this.firstNonZeroIndex = index;
    }
    if (this.significantDigits.length < MAX_COMPARE_DIGITS) {
      this.significantDigits += String.fromCharCode(0x30 + digit);
    } else if (digit !== 0) {
      this.discardedNonZero = true;
    }
  }

  private startExponent(digit: number | null): void {
    if (digit === null) this.state = "invalid";
    else {
      this.addExponentDigit(digit);
      this.state = "exponent-digits";
    }
  }

  private addExponentDigit(digit: number): void {
    if (this.exponentOverflow) return;
    if (this.exponentMagnitude > Math.floor((Number.MAX_SAFE_INTEGER - digit) / 10)) {
      this.exponentOverflow = true;
    } else {
      this.exponentMagnitude = this.exponentMagnitude * 10 + digit;
    }
  }
}

function asciiDigit(byte: number): number | null {
  return byte >= 0x30 && byte <= 0x39 ? byte - 0x30 : null;
}

function compareSignificands(input: string, discardedNonZero: boolean, boundary: string): number {
  for (let index = 0; index < MAX_COMPARE_DIGITS; index += 1) {
    const inputDigit = input.charCodeAt(index) || 0x30;
    const boundaryDigit = boundary.charCodeAt(index) || 0x30;
    if (inputDigit !== boundaryDigit) return inputDigit < boundaryDigit ? -1 : 1;
  }
  return discardedNonZero ? 1 : 0;
}

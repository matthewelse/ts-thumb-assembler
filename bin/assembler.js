"use strict";
/**
 * Copyright 2014 Gordon Williams (gw@pur3.co.uk)
 *
 * This Source Code is subject to the terms of the Mozilla Public
 * License, v2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * ------------------------------------------------------------------
 * Automatically run an assembler on inline assembler statements
 * ------------------------------------------------------------------
 */
Object.defineProperty(exports, "__esModule", { value: true });
/*  Thumb reference :
    http://ece.uwaterloo.ca/~ece222/ARM/ARM7-TDMI-manual-pt3.pdf

    ARM reference
    https://web.eecs.umich.edu/~prabal/teaching/eecs373-f11/readings/ARMv7-M_ARM.pdf
*/
// list of registers (for push/pop type commands)
var rlistLr = function (value) {
    var regs = value.split(",");
    var vals = {
        r0: 1,
        r1: 2,
        r2: 4,
        r3: 8,
        r4: 16,
        r5: 32,
        r6: 64,
        r7: 128,
        lr: 256,
    };
    var bits = 0;
    for (var _i = 0, regs_1 = regs; _i < regs_1.length; _i++) {
        var r = regs_1[_i];
        r = r.trim();
        if (!(r in vals)) {
            throw new Error("Unknown register name " + reg);
        }
        bits |= vals[r];
    }
    return bits;
};
var reg = function (regOffset) {
    return function (r) {
        var vals = {
            r0: 0,
            r1: 1,
            r2: 2,
            r3: 3,
            r4: 4,
            r5: 5,
            r6: 6,
            r7: 7,
        };
        if (!(r in vals)) {
            throw new Error("Unknown register name " + reg);
        }
        return vals[r] << regOffset;
    };
};
var reg4 = function (regOffset) {
    // 4 bit register
    return function (r) {
        var vals = {
            r0: 0,
            r1: 1,
            r2: 2,
            r3: 3,
            r4: 4,
            r5: 5,
            r6: 6,
            r7: 7,
            r8: 8,
            r9: 9,
            r10: 10,
            r11: 11,
            r12: 12,
            r13: 13,
            r14: 14,
            r15: 15,
            lr: 14,
            pc: 15,
        };
        if (!(r in vals)) {
            throw new Error("Unknown register name " + r);
        }
        return vals[r] << regOffset;
    };
};
var regOrImmediate = function (regOffset, immediateBit) {
    return function (r) {
        var regVal = parseInt(r, null);
        if (regVal >= 0 && regVal < 8) {
            return ((regVal & 7) << regOffset) | (1 << immediateBit);
        }
        var vals = {
            r0: 0,
            r1: 1,
            r2: 2,
            r3: 3,
            r4: 4,
            r5: 5,
            r6: 6,
            r7: 7,
        };
        if (!(r in vals)) {
            throw new Error("Unknown register name, or immediate out of range 0..7 " + r);
        }
        return vals[r] << regOffset;
    };
};
var regBaseOffset = function (baseOffset, offsetOffset) {
    return function (value) {
        var parms = value.split(",");
        return reg(baseOffset)(parms[0]) | reg(offsetOffset)(parms[0]);
    };
};
var thumb2ImmediateT3 = function (value) {
    if (value[0] !== "#") {
        throw new Error("Expecting '#' before number");
    }
    var v = parseInt(value.substr(1), null);
    if (v >= 0 && v < 65536) {
        // https://web.eecs.umich.edu/~prabal/teaching/eecs373-f11/readings/ARMv7-M_ARM.pdf page 347
        var imm4 = void 0;
        var i = void 0;
        var imm3 = void 0;
        var imm8 = void 0; // what the...?
        imm4 = (v >> 12) & 15;
        i = (v >> 11) & 1;
        imm3 = (v >> 8) & 7;
        imm8 = v & 255;
        return (i << 26) | (imm4 << 16) | (imm3 << 12) | imm8;
    }
    throw new Error("Invalid number '" + value + "' - must be between 0 and 65535");
};
var convertInt = function (offset, bits, shift, signed) {
    return function (value, labels) {
        var maxValue = ((1 << bits) - 1) << shift;
        var minValue = 0;
        if (signed) {
            minValue = -(1 << (bits - 1));
            maxValue += minValue;
        }
        var binValue;
        if (value[0] === "#") {
            binValue = parseInt(value.substr(1), null);
        }
        else {
            var addValue = 0;
            var maths = value.indexOf("+");
            if (maths >= 0) {
                addValue = parseInt(value.substr(maths), null);
                value = value.substr(0, maths);
            }
            if (value in labels) {
                binValue = labels[value] + addValue - labels.PC;
            }
            else {
                throw new Error("Unknown label '" + value + "'");
            }
        }
        // console.log("VALUE----------- "+binValue+" PC "+labels["PC"]+" L "+labels[value]);
        if (binValue >= minValue && binValue <= maxValue && (binValue & ((1 << shift) - 1)) === 0) {
            return ((binValue >> shift) & ((1 << bits) - 1)) << offset;
        }
        var msg = "Invalid number '" + value + "' (" + binValue + ") - must be between 0 and " + maxValue;
        if (shift !== 0) {
            msg += " and a multiple of " + (1 << shift);
        }
        throw msg;
    };
};
var uint = function (offset, bits, shift) {
    return convertInt(offset, bits, shift, false);
};
var sint = function (offset, bits, shift) {
    return convertInt(offset, bits, shift, true);
};
// special 23-bit address (bottom bit ignored) split into two halves
var blAddr = function () {
    var normal = sint(0, 22, 1); // un-split address
    return function (value, labels) {
        var v = normal(value, labels);
        return (((v >> 11) & 0x7ff) << 16) | (v & 0x7ff);
    };
};
var ops = {
    // Format 1: move shifted register
    lsl: [
        {
            base: "00000-----___---",
            regex: /(r[0-7]),(r[0-7]),(#[0-9]+)$/,
            args: [reg(0), reg(3), uint(6, 5, 0)],
        },
        {
            base: "0100000010___---",
            regex: /(r[0-7]),(r[0-7])$/,
            args: [reg(0), reg(3)],
        },
    ],
    lsr: [
        {
            base: "00001-----___---",
            regex: /(r[0-7]),(r[0-7]),(#[0-9]+)$/,
            args: [reg(0), reg(3), uint(6, 5, 0)],
        },
        {
            base: "0100000011___---",
            regex: /(r[0-7]),(r[0-7])$/,
            args: [reg(0), reg(3)],
        },
    ],
    asr: [
        {
            base: "00010-----___---",
            regex: /(r[0-7]),(r[0-7]),(#[0-9]+)$/,
            args: [reg(0), reg(3), uint(6, 5, 0)],
        },
        {
            base: "0100000100___---",
            regex: /(r[0-7]),(r[0-7])$/,
            args: [reg(0), reg(3)],
        },
    ],
    // 5.2 Format 2: add/subtract
    // 00011
    // 5.3 Format 3: move/compare/add/subtract immediate
    cmp: [
        // move/compare/subtract immediate
        {
            base: "00101---________",
            regex: /(r[0-7]),(#[0-9]+)$/,
            args: [reg(8), uint(0, 8, 0)],
        },
        {
            base: "0100001010___---",
            regex: /(r[0-7]),(r[0-7])$/,
            args: [reg(0), reg(3)],
        },
    ],
    // 5.4 Format 4: ALU operations
    and: [
        {
            base: "0100000000___---",
            regex: /(r[0-7]),(r[0-7])$/,
            args: [reg(0), reg(3)],
        },
    ],
    eor: [
        {
            base: "0100000001___---",
            regex: /(r[0-7]),(r[0-7])$/,
            args: [reg(0), reg(3)],
        },
    ],
    // lsl is above
    // lsr is above
    // asr is above
    adc: [
        {
            base: "0100000101___---",
            regex: /(r[0-7]),(r[0-7])$/,
            args: [reg(0), reg(3)],
        },
    ],
    sbc: [
        {
            base: "0100000110___---",
            regex: /(r[0-7]),(r[0-7])$/,
            args: [reg(0), reg(3)],
        },
    ],
    ror: [
        {
            base: "0100000111___---",
            regex: /(r[0-7]),(r[0-7])$/,
            args: [reg(0), reg(3)],
        },
    ],
    tst: [
        {
            base: "0100001000___---",
            regex: /(r[0-7]),(r[0-7])$/,
            args: [reg(0), reg(3)],
        },
    ],
    neg: [
        {
            base: "0100001001___---",
            regex: /(r[0-7]),(r[0-7])$/,
            args: [reg(0), reg(3)],
        },
    ],
    // cmp is above
    cmn: [
        {
            base: "0100001011___---",
            regex: /(r[0-7]),(r[0-7])$/,
            args: [reg(0), reg(3)],
        },
    ],
    orr: [
        {
            base: "0100001100___---",
            regex: /(r[0-7]),(r[0-7])$/,
            args: [reg(0), reg(3)],
        },
    ],
    mul: [
        {
            base: "0100001101___---",
            regex: /(r[0-7]),(r[0-7])$/,
            args: [reg(0), reg(3)],
        },
    ],
    bic: [
        {
            base: "0100001110___---",
            regex: /(r[0-7]),(r[0-7])$/,
            args: [reg(0), reg(3)],
        },
    ],
    mvn: [
        {
            base: "0100001111___---",
            regex: /(r[0-7]),(r[0-7])$/,
            args: [reg(0), reg(3)],
        },
    ],
    // 5.5 Format 5: Hi register operations/branch exchange
    // 5.6 Format 6: PC-relative load
    //  done (below)
    // 5.7 Format 7: load/store with register offset
    //  done (below)
    // 5.8 Format 8: load/store sign-extended byte/halfword
    // 5.9 Format 9: load/store with immediate offset
    //  done (below)
    // 5.10 Format 10: load/store halfword
    // 5.11 Format 11: SP-relative load/store
    // 5.12 Format 12: load address
    // done (below)
    // 5.13 Format 13: add offset to Stack Pointer
    // 5.14 Format 14: push/pop registers
    //  done (below)
    // 5.16 Format 16: conditional branch
    beq: [{ base: "11010000________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }],
    bne: [{ base: "11010001________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }],
    bcs: [{ base: "11010010________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }],
    bcc: [{ base: "11010011________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }],
    bmi: [{ base: "11010100________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }],
    bpl: [{ base: "11010101________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }],
    bvs: [{ base: "11010110________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }],
    bvc: [{ base: "11010111________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }],
    bhi: [{ base: "11011000________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }],
    bls: [{ base: "11011001________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }],
    bge: [{ base: "11011010________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }],
    blt: [{ base: "11011011________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }],
    bgt: [{ base: "11011100________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }],
    ble: [{ base: "11011101________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }],
    // 5.17 Format 17: software interrupt
    // 5.18 Format 18: unconditional branch
    b: [{ base: "11100___________", regex: /^(.*)$/, args: [sint(0, 11, 1)] }],
    // 5.19 Format 19: long branch with link
    bl: [
        {
            base: "11110___________11111___________",
            regex: /^(.*)$/,
            args: [blAddr()],
        },
    ],
    bx: [{ base: "010001110----000", regex: /(lr|r[0-9]+)$/, args: [reg4(3)] }],
    // ....
    adr: [
        {
            base: "10100---________",
            regex: /^(r[0-7]),([a-zA-Z_][0-9a-zA-Z_]*)$/,
            args: [reg(8), uint(0, 8, 2)],
        },
        {
            base: "10100---________",
            regex: /^(r[0-7]),([a-zA-Z_][0-9a-zA-Z_]*\+[0-9]+)$/,
            args: [reg(8), uint(0, 8, 2)],
        },
    ],
    push: [{ base: "1011010-________", regex: /^{(.*)}$/, args: [rlistLr] }],
    pop: [{ base: "1011110-________", regex: /^{(.*)}$/, args: [rlistLr] }],
    add: [
        {
            base: "00110---________",
            regex: /(r[0-7]),(#[0-9]+)$/,
            args: [reg(8), uint(0, 8, 0)],
        },
        {
            base: "10100---________",
            regex: /^(r[0-7]),pc,(#[0-9]+)$/,
            args: [reg(8), uint(0, 8, 2)],
        },
        {
            base: "10101---________",
            regex: /^(r[0-7]),sp,(#[0-9]+)$/,
            args: [reg(8), uint(0, 8, 2)],
        },
        {
            base: "101100000_______",
            regex: /^sp,(#[0-9]+)$/,
            args: [uint(0, 7, 2)],
        },
        {
            base: "00011-0___---___",
            regex: /^(r[0-7]),(r[0-7]),([^,]+)$/,
            args: [reg(0), reg(3), regOrImmediate(6, 10)],
        },
    ],
    adds: [
        {
            base: "00011-0___---___",
            regex: /^(r[0-7]),(r[0-7]),([^,]+)$/,
            args: [reg(0), reg(3), regOrImmediate(6, 10)],
        },
    ],
    "adc.w": [
        {
            base: "111010110100----________--------",
            regex: /^(r[0-7]),(r[0-7]),(r[0-7])$/,
            args: [reg(16), reg(8), reg(0)],
        },
    ],
    "add.w": [
        {
            base: "11110001--------________--------",
            regex: /^(r[0-7]),(r[0-7]),(#[0-9]+)$/,
            args: [reg(16), reg(8), uint(0, 8, 0)],
        },
    ],
    sub: [
        {
            base: "00111---________",
            regex: /(r[0-7]),(#[0-9]+)$/,
            args: [reg(8), uint(0, 8, 0)],
        },
        /*{ base:"10100---________", regex : /^([^,]+),pc,(#[0-9]+)$/,args:[reg(8),uint(0,8,2)] },*/
        {
            base: "101100001_______",
            regex: /^sp,(#[0-9]+)$/,
            args: [uint(0, 7, 2)],
        },
        {
            base: "00011-1___---___",
            regex: /^([^,]+),([^,]+),([^,]+)$/,
            args: [reg(0), reg(3), regOrImmediate(6, 10)],
        },
    ],
    str: [
        {
            base: "0101000---___---",
            regex: /(r[0-7]),\[(r[0-7]),(r[0-7])\]$/,
            args: [reg(0), reg(3), reg(6)],
        },
        {
            base: "10010---________",
            regex: /(r[0-7]),\[sp,(#[0-9]+)\]$/,
            args: [reg(8), uint(0, 8, 2)],
        },
        {
            base: "0110000000___---",
            regex: /(r[0-7]),\[(r[0-7])\]$/,
            args: [reg(0), reg(3)],
        },
        {
            base: "0110000---___---",
            regex: /(r[0-7]),\[(r[0-7]),(#[0-9]+)\]$/,
            args: [reg(0), reg(3), uint(6, 5, 2)],
        },
    ],
    strb: [
        {
            base: "0101010---___---",
            regex: /(r[0-7]),\[(r[0-7]),(r[0-7])\]$/,
            args: [reg(0), reg(3), reg(6)],
        },
        {
            base: "0111000---___---",
            regex: /(r[0-7]),\[(r[0-7]),(#[0-9]+)\]$/,
            args: [reg(0), reg(3), uint(6, 5, 2)],
        },
    ],
    ldr: [
        {
            base: "01001---________",
            regex: /(r[0-7]),\[pc,(#[0-9]+)\]$/,
            args: [reg(8), uint(0, 8, 2)],
        },
        {
            base: "10011---________",
            regex: /(r[0-7]),\[sp,(#[0-9]+)\]$/,
            args: [reg(8), uint(0, 8, 2)],
        },
        {
            base: "01001---________",
            regex: /(r[0-7]),([a-zA-Z_][0-9a-zA-Z_]*)$/,
            args: [reg(8), uint(0, 8, 2)],
        },
        {
            base: "01001---________",
            regex: /(r[0-7]),([a-zA-Z_][0-9a-zA-Z_]*\+[0-9]+)$/,
            args: [reg(8), uint(0, 8, 2)],
        },
        {
            base: "0101100---___---",
            regex: /(r[0-7]),\[(r[0-7]),(r[0-7])\]$/,
            args: [reg(0), reg(3), reg(6)],
        },
        {
            base: "0110100000___---",
            regex: /(r[0-7]),\[(r[0-7])\]$/,
            args: [reg(0), reg(3)],
        },
        {
            base: "0110100---___---",
            regex: /(r[0-7]),\[(r[0-7]),(#[0-9]+)\]$/,
            args: [reg(0), reg(3), uint(6, 5, 2)],
        },
    ],
    ldrb: [
        {
            base: "0101110---___---",
            regex: /(r[0-7]),\[(r[0-7]),(r[0-7])\]$/,
            args: [reg(0), reg(3), reg(6)],
        },
        {
            base: "0110100---___---",
            regex: /(r[0-7]),\[(r[0-7]),(#[0-9]+)\]$/,
            args: [reg(0), reg(3), uint(6, 5, 2)],
        },
    ],
    mov: [
        {
            base: "00100---________",
            regex: /(r[0-7]),(#[0-9]+)$/,
            args: [reg(8), uint(0, 8, 0)],
        },
        {
            base: "0001110000---___",
            regex: /(r[0-7]),(r[0-7])$/,
            args: [reg(0), reg(3)],
        },
        { base: "0100011010---101", regex: /sp,(r[0-7])$/, args: [reg(3)] },
    ],
    movs: [
        {
            base: "00100---________",
            regex: /(r[0-7]),(#[0-9]+)$/,
            args: [reg(8), uint(0, 8, 0)],
        },
    ],
    movw: [
        {
            base: "11110-100100----0___----________",
            regex: /(r[0-7]),(#[0-9]+)$/,
            args: [reg4(8), thumb2ImmediateT3],
        },
    ],
    ".word": [
        {
            base: "--------------------------------",
            regex: /0x([0-9A-Fa-f]+)$/,
            args: [
                function (v) {
                    var vi = parseInt(v, 16);
                    return (vi >> 16) | (vi << 16);
                },
            ],
        },
        {
            base: "--------------------------------",
            regex: /([0-9]+)$/,
            args: [
                function (v) {
                    var vi = parseInt(v, null);
                    return (vi >> 16) | (vi << 16);
                },
            ],
        },
    ],
    nop: [{ base: "0100011011000000", regex: new RegExp(""), args: [] }],
    cpsie: [{ base: "1011011001100010", regex: /i/, args: [] }],
    cpsid: [{ base: "1011011001110010", regex: /i/, args: [] }],
    wfe: [{ base: "1011111100100000", regex: /i/, args: [] }],
    wfi: [{ base: "1011111100110000", regex: /i/, args: [] }],
    // for this, uint needs to work without a hash
    //    "swi"    :[{ base:"11011111--------", regex : /([0-9]+)$/, args:[uint(0,8,0)] }],
    // Format 17: software interrupt
    bkpt: [{ base: "10111110--------", regex: /(#[0-9]+)$/, args: [uint(0, 8, 0)] }],
};
var getOpCode = function (binary) {
    var base = "";
    for (var i = 0; i < binary.length; i++) {
        var b = binary[i];
        if ("-_".indexOf(b) >= 0) {
            base += "0";
        }
        else {
            base += b;
        }
    }
    var opCode = parseInt(base, 2);
    if (opCode < 0) {
        opCode = opCode + 2147483648.0;
    }
    return opCode;
};
var assembleInternal = function (asmLines, wordCallback, labels) {
    var addr = 0;
    var newLabels = {};
    asmLines.forEach(function (line) {
        // setup labels
        if (labels !== undefined) {
            labels.PC = addr + 4;
        }
        // handle line
        line = line.trim();
        if (line === "") {
            return;
        }
        if (line.substr(-1) === ":") {
            // it's a label
            var labelName = line.substr(0, line.length - 1);
            if (newLabels[labelName] !== undefined) {
                throw new Error("Label '" + labelName + "' was already defined");
            }
            newLabels[labelName] = addr;
            return;
        }
        // parse instruction
        var firstArgEnd = line.indexOf("\t");
        if (firstArgEnd < 0) {
            firstArgEnd = line.indexOf(" ");
        }
        if (firstArgEnd < 0) {
            firstArgEnd = line.length;
        }
        var opName = line.substr(0, firstArgEnd);
        var args = line.substr(firstArgEnd).replace(/[ \t]/g, "").trim();
        if (!(opName in ops)) {
            throw new Error("Unknown Op '" + opName + "' in '" + line + "'");
        }
        // search ops
        var found = false;
        for (var _i = 0, _a = ops[opName]; _i < _a.length; _i++) {
            var op = _a[_i];
            var m = args.match(op.regex);
            if (m) {
                found = true;
                // work out the base opcode
                var opCode = getOpCode(op.base);
                if (labels !== undefined) {
                    // If we're properly generating code, parse each argument.
                    // Otherwise we're just working out the size in bytes of each line
                    // and we can skip this
                    for (var i = 0; i < op.args.length; i++) {
                        // console.log(i,m[(i|0)+1]);
                        var argFunction = op.args[i];
                        var bits = argFunction(m[(i | 0) + 1], labels);
                        // console.log("  ",bits)
                        opCode |= bits;
                    }
                }
                if (op.base.length > 16) {
                    wordCallback(opCode >>> 16);
                    wordCallback(opCode & 0xffff);
                    addr += 4;
                }
                else {
                    wordCallback(opCode);
                    addr += 2;
                }
                break;
            }
        }
        // now parse args
        if (!found) {
            throw new Error("Unknown arg style '" + args + "' in '" + line + "'");
        }
    });
    return newLabels;
};
var assemble = function (asmLines, wordCallback) {
    var labels = assembleInternal(asmLines, function () {
        /* empty */
    }, undefined);
    assembleInternal(asmLines, wordCallback, labels);
};
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
exports.assembleBlock = function (asmLines) {
    var machineCode = [];
    try {
        assemble(asmLines, function (word) {
            machineCode.push(word);
        });
    }
    catch (err) {
        console.error("Assembler failed: " + err);
        return undefined;
    }
    if (machineCode.length % 2 == 1) {
        machineCode.push(0);
    }
    return new Uint32Array(machineCode);
};
//# sourceMappingURL=assembler.js.map
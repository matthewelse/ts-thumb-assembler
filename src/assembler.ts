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

/*  Thumb reference :
    http://ece.uwaterloo.ca/~ece222/ARM/ARM7-TDMI-manual-pt3.pdf

    ARM reference
    https://web.eecs.umich.edu/~prabal/teaching/eecs373-f11/readings/ARMv7-M_ARM.pdf
*/

// list of registers (for push/pop type commands)
const rlistLr = (value: string) => {
    const regs = value.split(",");
    const vals: { [register: string]: number } = {
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

    let bits = 0;

    for (let r of regs) {
        r = r.trim();
        if (!(r in vals)) {
            throw new Error("Unknown register name " + reg);
        }
        bits |= vals[r];
    }

    return bits;
};

const reg = (regOffset: number) => {
    return (r: string) => {
        const vals: { [register: string]: number } = {
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

const reg4 = (regOffset: number) => {
    // 4 bit register
    return (r: number) => {
        const vals: { [register: string]: number } = {
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

const regOrImmediate = (regOffset: number, immediateBit: number) => {
    return (r: string) => {
        const regVal = parseInt(r, null);
        if (regVal >= 0 && regVal < 8) {
            return ((regVal & 7) << regOffset) | (1 << immediateBit);
        }

        const vals: { [register: string]: number } = {
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

const regBaseOffset = (baseOffset: number, offsetOffset: number) => {
    return (value: string) => {
        const parms = value.split(",");
        return reg(baseOffset)(parms[0]) | reg(offsetOffset)(parms[0]);
    };
};

const thumb2ImmediateT3 = (value: string) => {
    if (value[0] !== "#") {
        throw new Error("Expecting '#' before number");
    }
    const v = parseInt(value.substr(1), null);
    if (v >= 0 && v < 65536) {
        // https://web.eecs.umich.edu/~prabal/teaching/eecs373-f11/readings/ARMv7-M_ARM.pdf page 347
        let imm4;
        let i;
        let imm3;
        let imm8; // what the...?

        imm4 = (v >> 12) & 15;
        i = (v >> 11) & 1;
        imm3 = (v >> 8) & 7;
        imm8 = v & 255;
        return (i << 26) | (imm4 << 16) | (imm3 << 12) | imm8;
    }
    throw new Error("Invalid number '" + value + "' - must be between 0 and 65535");
};

const convertInt = (offset: number, bits: number, shift: number, signed: boolean) => {
    return (value: string, labels: { [register: string]: number }) => {
        let maxValue = ((1 << bits) - 1) << shift;
        let minValue = 0;
        if (signed) {
            minValue = -(1 << (bits - 1));
            maxValue += minValue;
        }

        let binValue;
        if (value[0] === "#") {
            binValue = parseInt(value.substr(1), null);
        } else {
            let addValue = 0;
            const maths = value.indexOf("+");
            if (maths >= 0) {
                addValue = parseInt(value.substr(maths), null);
                value = value.substr(0, maths);
            }

            if (value in labels) {
                binValue = labels[value] + addValue - labels.PC;
            } else {
                throw new Error("Unknown label '" + value + "'");
            }
        }

        // console.log("VALUE----------- "+binValue+" PC "+labels["PC"]+" L "+labels[value]);

        if (binValue >= minValue && binValue <= maxValue && (binValue & ((1 << shift) - 1)) === 0) {
            return ((binValue >> shift) & ((1 << bits) - 1)) << offset;
        }

        let msg = "Invalid number '" + value + "' (" + binValue + ") - must be between 0 and " + maxValue;
        if (shift !== 0) {
            msg += " and a multiple of " + (1 << shift);
        }

        throw msg;
    };
};

const uint = (offset: number, bits: number, shift: number) => {
    return convertInt(offset, bits, shift, false);
};

const sint = (offset: number, bits: number, shift: number) => {
    return convertInt(offset, bits, shift, true);
};

// special 23-bit address (bottom bit ignored) split into two halves
const blAddr = () => {
    const normal = sint(0, 22, 1); // un-split address
    return (value: string, labels: { [register: string]: number }) => {
        const v = normal(value, labels);
        return (((v >> 11) & 0x7ff) << 16) | (v & 0x7ff);
    };
};

interface InstructionFormat {
    base: string;
    regex: RegExp;
    args: any[];
}

let ops: { [op: string]: InstructionFormat[] } = {
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
    ], // 5.4 d = d << s
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
    ], // 5.4 d = d >> s
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
    ], // 5.4 d = d >>> s
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
    ], // 5.4 test d-s
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
    ], // d + s + carry
    sbc: [
        {
            base: "0100000110___---",
            regex: /(r[0-7]),(r[0-7])$/,
            args: [reg(0), reg(3)],
        },
    ], // d - s - !carry
    ror: [
        {
            base: "0100000111___---",
            regex: /(r[0-7]),(r[0-7])$/,
            args: [reg(0), reg(3)],
        },
    ], // rotate right
    tst: [
        {
            base: "0100001000___---",
            regex: /(r[0-7]),(r[0-7])$/,
            args: [reg(0), reg(3)],
        },
    ], // test
    neg: [
        {
            base: "0100001001___---",
            regex: /(r[0-7]),(r[0-7])$/,
            args: [reg(0), reg(3)],
        },
    ], // - s
    // cmp is above
    cmn: [
        {
            base: "0100001011___---",
            regex: /(r[0-7]),(r[0-7])$/,
            args: [reg(0), reg(3)],
        },
    ], // test d+s
    orr: [
        {
            base: "0100001100___---",
            regex: /(r[0-7]),(r[0-7])$/,
            args: [reg(0), reg(3)],
        },
    ], // |
    mul: [
        {
            base: "0100001101___---",
            regex: /(r[0-7]),(r[0-7])$/,
            args: [reg(0), reg(3)],
        },
    ], // s*d
    bic: [
        {
            base: "0100001110___---",
            regex: /(r[0-7]),(r[0-7])$/,
            args: [reg(0), reg(3)],
        },
    ], // d & ~s
    mvn: [
        {
            base: "0100001111___---",
            regex: /(r[0-7]),(r[0-7])$/,
            args: [reg(0), reg(3)],
        },
    ], // ~s
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
    beq: [{ base: "11010000________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }], // 5.16 Format 16: conditional branch
    bne: [{ base: "11010001________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }], // 5.16 Format 16: conditional branch
    bcs: [{ base: "11010010________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }], // 5.16 Format 16: conditional branch
    bcc: [{ base: "11010011________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }], // 5.16 Format 16: conditional branch
    bmi: [{ base: "11010100________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }], // 5.16 Format 16: conditional branch
    bpl: [{ base: "11010101________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }], // 5.16 Format 16: conditional branch
    bvs: [{ base: "11010110________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }], // 5.16 Format 16: conditional branch
    bvc: [{ base: "11010111________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }], // 5.16 Format 16: conditional branch
    bhi: [{ base: "11011000________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }], // 5.16 Format 16: conditional branch
    bls: [{ base: "11011001________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }], // 5.16 Format 16: conditional branch
    bge: [{ base: "11011010________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }], // 5.16 Format 16: conditional branch
    blt: [{ base: "11011011________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }], // 5.16 Format 16: conditional branch
    bgt: [{ base: "11011100________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }], // 5.16 Format 16: conditional branch
    ble: [{ base: "11011101________", regex: /^(.*)$/, args: [sint(0, 8, 1)] }], // 5.16 Format 16: conditional branch
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
        }, // ADR pseudo-instruction to save address (actually ADD PC)
        {
            base: "10100---________",
            regex: /^(r[0-7]),([a-zA-Z_][0-9a-zA-Z_]*\+[0-9]+)$/,
            args: [reg(8), uint(0, 8, 2)],
        },
    ],
    push: [{ base: "1011010-________", regex: /^{(.*)}$/, args: [rlistLr] }], // 5.14 Format 14: push/pop registers
    pop: [{ base: "1011110-________", regex: /^{(.*)}$/, args: [rlistLr] }], // 5.14 Format 14: push/pop registers
    add: [
        {
            base: "00110---________",
            regex: /(r[0-7]),(#[0-9]+)$/,
            args: [reg(8), uint(0, 8, 0)],
        }, // move/compare/subtract immediate
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
    ], // Format 2: add/subtract
    adds: [
        {
            base: "00011-0___---___",
            regex: /^(r[0-7]),(r[0-7]),([^,]+)$/,
            args: [reg(0), reg(3), regOrImmediate(6, 10)],
        },
    ], // ?
    "adc.w": [
        {
            base: "111010110100----________--------",
            regex: /^(r[0-7]),(r[0-7]),(r[0-7])$/,
            args: [reg(16), reg(8), reg(0)],
        },
    ], // made this up. probably wrong
    "add.w": [
        {
            base: "11110001--------________--------",
            regex: /^(r[0-7]),(r[0-7]),(#[0-9]+)$/,
            args: [reg(16), reg(8), uint(0, 8, 0)],
        },
    ], // made this up. probably wrong
    sub: [
        {
            base: "00111---________",
            regex: /(r[0-7]),(#[0-9]+)$/,
            args: [reg(8), uint(0, 8, 0)],
        }, // move/compare/subtract immediate
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
        }, // 5.7 Format 7: load/store with register offset
        {
            base: "10010---________",
            regex: /(r[0-7]),\[sp,(#[0-9]+)\]$/,
            args: [reg(8), uint(0, 8, 2)],
        }, // 5.11 SP-relative store
        {
            base: "0110000000___---",
            regex: /(r[0-7]),\[(r[0-7])\]$/,
            args: [reg(0), reg(3)],
        }, // 5.9 Format 9: load/store with no offset
        {
            base: "0110000---___---",
            regex: /(r[0-7]),\[(r[0-7]),(#[0-9]+)\]$/,
            args: [reg(0), reg(3), uint(6, 5, 2)],
        },
    ], // 5.9 Format 9: load/store with immediate offset
    strb: [
        {
            base: "0101010---___---",
            regex: /(r[0-7]),\[(r[0-7]),(r[0-7])\]$/,
            args: [reg(0), reg(3), reg(6)],
        }, // 5.7 Format 7: load/store with register offset
        {
            base: "0111000---___---",
            regex: /(r[0-7]),\[(r[0-7]),(#[0-9]+)\]$/,
            args: [reg(0), reg(3), uint(6, 5, 2)],
        },
    ], // 5.9 Format 9: load/store with immediate offset
    ldr: [
        {
            base: "01001---________",
            regex: /(r[0-7]),\[pc,(#[0-9]+)\]$/,
            args: [reg(8), uint(0, 8, 2)],
        }, // 5.6 Format 6: PC-relative load
        {
            base: "10011---________",
            regex: /(r[0-7]),\[sp,(#[0-9]+)\]$/,
            args: [reg(8), uint(0, 8, 2)],
        }, // 5.11 SP-relative load
        {
            base: "01001---________",
            regex: /(r[0-7]),([a-zA-Z_][0-9a-zA-Z_]*)$/,
            args: [reg(8), uint(0, 8, 2)],
        }, // 5.6 Format 6: PC-relative load (using label)
        {
            base: "01001---________",
            regex: /(r[0-7]),([a-zA-Z_][0-9a-zA-Z_]*\+[0-9]+)$/,
            args: [reg(8), uint(0, 8, 2)],
        }, // 5.6 Format 6: PC-relative load (using label and maths - huge hack)
        {
            base: "0101100---___---",
            regex: /(r[0-7]),\[(r[0-7]),(r[0-7])\]$/,
            args: [reg(0), reg(3), reg(6)],
        }, // 5.7 Format 7: load/store with register offset
        {
            base: "0110100000___---",
            regex: /(r[0-7]),\[(r[0-7])\]$/,
            args: [reg(0), reg(3)],
        }, // 5.9 Format 9: load/store with no offset
        {
            base: "0110100---___---",
            regex: /(r[0-7]),\[(r[0-7]),(#[0-9]+)\]$/,
            args: [reg(0), reg(3), uint(6, 5, 2)],
        },
    ], // 5.9 Format 9: load/store with immediate offset

    ldrb: [
        {
            base: "0101110---___---",
            regex: /(r[0-7]),\[(r[0-7]),(r[0-7])\]$/,
            args: [reg(0), reg(3), reg(6)],
        }, // 5.7 Format 7: load/store with register offset
        {
            base: "0110100---___---",
            regex: /(r[0-7]),\[(r[0-7]),(#[0-9]+)\]$/,
            args: [reg(0), reg(3), uint(6, 5, 2)],
        },
    ], // 5.9 Format 9: load/store with immediate offset
    mov: [
        {
            base: "00100---________",
            regex: /(r[0-7]),(#[0-9]+)$/,
            args: [reg(8), uint(0, 8, 0)],
        }, // move/compare/subtract immediate
        {
            base: "0001110000---___",
            regex: /(r[0-7]),(r[0-7])$/,
            args: [reg(0), reg(3)],
        }, // actually 'add Rd,Rs,#0'
        { base: "0100011010---101", regex: /sp,(r[0-7])$/, args: [reg(3)] },
    ], // made up again
    movs: [
        {
            base: "00100---________",
            regex: /(r[0-7]),(#[0-9]+)$/,
            args: [reg(8), uint(0, 8, 0)],
        },
    ], // is this even in thumb?
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
                (v: string) => {
                    const vi = parseInt(v, 16);
                    return (vi >> 16) | (vi << 16);
                },
            ],
        },
        {
            base: "--------------------------------",
            regex: /([0-9]+)$/,
            args: [
                (v: string) => {
                    const vi = parseInt(v, null);
                    return (vi >> 16) | (vi << 16);
                },
            ],
        },
    ],
    nop: [{ base: "0100011011000000", regex: new RegExp(""), args: [] }], // MOV R8,R8 (Format 5)
    cpsie: [{ base: "1011011001100010", regex: /i/, args: [] }], // made up again
    cpsid: [{ base: "1011011001110010", regex: /i/, args: [] }], // made up again
    wfe: [{ base: "1011111100100000", regex: /i/, args: [] }],
    wfi: [{ base: "1011111100110000", regex: /i/, args: [] }],

    // for this, uint needs to work without a hash
    //    "swi"    :[{ base:"11011111--------", regex : /([0-9]+)$/, args:[uint(0,8,0)] }],
    // Format 17: software interrupt
    bkpt: [{ base: "10111110--------", regex: /(#[0-9]+)$/, args: [uint(0, 8, 0)] }],
};

const getOpCode = (binary: string) => {
    let base = "";
    for (let i = 0; i < binary.length; i++) {
        const b = binary[i];
        if ("-_".indexOf(b) >= 0) {
            base += "0";
        } else {
            base += b;
        }
    }

    let opCode = parseInt(base, 2);
    if (opCode < 0) {
        opCode = opCode + 2147483648.0;
    }
    return opCode;
};

const assembleInternal = (asmLines: string[], wordCallback: (w: number) => void, labels: { [reg: string]: number }) => {
    let addr = 0;
    const newLabels: { [name: string]: number } = {};
    asmLines.forEach((line: string) => {
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
            const labelName = line.substr(0, line.length - 1);

            if (newLabels[labelName] !== undefined) {
                throw new Error("Label '" + labelName + "' was already defined");
            }
            newLabels[labelName] = addr;

            return;
        }

        // parse instruction
        let firstArgEnd = line.indexOf("\t");
        if (firstArgEnd < 0) {
            firstArgEnd = line.indexOf(" ");
        }
        if (firstArgEnd < 0) {
            firstArgEnd = line.length;
        }

        const opName = line.substr(0, firstArgEnd);
        const args = line.substr(firstArgEnd).replace(/[ \t]/g, "").trim();

        if (!(opName in ops)) {
            throw new Error("Unknown Op '" + opName + "' in '" + line + "'");
        }

        // search ops
        let found = false;
        for (const op of ops[opName]) {
            const m = args.match(op.regex);

            if (m) {
                found = true;
                // work out the base opcode
                let opCode = getOpCode(op.base);

                if (labels !== undefined) {
                    // If we're properly generating code, parse each argument.
                    // Otherwise we're just working out the size in bytes of each line
                    // and we can skip this
                    for (let i = 0; i < op.args.length; i++) {
                        // console.log(i,m[(i|0)+1]);
                        const argFunction = op.args[i];
                        const bits = argFunction(m[(i | 0) + 1], labels);
                        // console.log("  ",bits)
                        opCode |= bits;
                    }
                }

                if (op.base.length > 16) {
                    wordCallback(opCode >>> 16);
                    wordCallback(opCode & 0xffff);
                    addr += 4;
                } else {
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

const assemble = (asmLines: string[], wordCallback: (w: number) => void) => {
    const labels = assembleInternal(
        asmLines,
        () => {
            /* empty */
        },
        undefined,
    );
    console.log(labels);
    assembleInternal(asmLines, wordCallback, labels);
};

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export const assembleBlock = (asmLines: string[]) => {
    const machineCode: string[] = [];
    try {
        assemble(asmLines, (word: number) => {
            machineCode.push("0x" + word.toString(16));
        });
    } catch (err) {
        console.error("Assembler failed: " + err);
        return undefined;
    }

    return machineCode;
};

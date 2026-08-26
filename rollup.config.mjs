import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import typescript from "@rollup/plugin-typescript";
import { dts } from "rollup-plugin-dts";


function rollupGasBundler(options = {}) {
    const {
        namespaceName = "GQuery",
        wrapGlobalDts = false,
        addIifeShims = false,
        returnClassName = "GQuery",
    } = options;

    return {
        name: "rollup-gas-bundler",
        generateBundle(outputOptions, bundle) {
            const bundleName = outputOptions.name;
            const isIife = outputOptions.format === "iife";
            const isGlobalDts = outputOptions.file?.endsWith("bundle.global.d.ts");

            if (isIife && addIifeShims && !bundleName) throw new Error("Set output.name for iife bundling.");

            for (const file of Object.values(bundle)) {
                if (file.type !== "chunk") continue;

                if (isIife) {
                    const returnTarget = `exports.${returnClassName}`;
                    const returnPatch = `return Object.assign(${returnTarget}, exports);`;
                    if (file.code.includes("return exports;")) {
                        if (!file.code.includes(returnTarget)) {
                            throw new Error(`Missing export ${returnClassName} in IIFE bundle.`);
                        }
                        file.code = file.code.replace("return exports;", returnPatch);
                    }
                }

                if (isIife && addIifeShims) {
                    const footerLines = [];
                    footerLines.push(
                        ...(file.exports || []).map(
                            (exportedFunction) => `function ${exportedFunction}(...args) { return ${bundleName}.${exportedFunction}(...args); }`
                        )
                    );
                    if (footerLines.length > 0) {
                        file.code = footerLines.join("\n") + "\n" + file.code;
                    }
                }

                if (wrapGlobalDts && isGlobalDts) {
                    const indented = file.code
                        .split("\n")
                        .map((line) => line.length > 0 ? "  " + line : line)
                        .join("\n");
                    file.code = `declare namespace ${namespaceName} {\n${indented}\n}\ndeclare var ${namespaceName}: typeof ${namespaceName};\n`;
                }
            }
        }
    };
}

const plugins = [
    resolve({ browser: true, preferBuiltins: false }),
    commonjs(),
    typescript({ tsconfig: "./tsconfig.json" })
];

export default [
    {
        input: "src/index.ts",
        output: {
            file: "dist/bundle.js",
            format: "es",
            interop: "esModule",
            name: "GQuery",
        },
        plugins,
        external: ["google-apps-script"],
    },
    {
        input: "src/index.ts",
        output: {
            file: "dist/bundle.global.js",
            format: "iife",
            interop: "esModule",
            name: "GQuery",
        },
        plugins: [...plugins, rollupGasBundler()],
        external: ["google-apps-script"],
    },
    {
        input: "dist/types/index.d.ts",
        output: [{ file: "dist/bundle.d.ts", format: "es" }],
        plugins: [dts()],
    },
    {
        input: "dist/types/index.d.ts",
        output: [{ file: "dist/bundle.global.d.ts", format: "es" }],
        plugins: [dts(), rollupGasBundler({ wrapGlobalDts: true, namespaceName: "GQuery" })],
    },
];

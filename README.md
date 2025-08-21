# h3-txikijs-adapter

A H3@2.0 adapter for [txiki.js](https://github.com/saghul/txiki.js)

## Installation
```
# npm
npm install h3-txikijs-adapter
# or yarn
yarn install h3-txikijs-adapter
# or pnpm
pnpm install h3-txikijs-adapter
```

## Usage
Only works with `H3@2.0.0` and up (which is currently in beta at 2025).

```ts
import { H3 } from "h3";
import { serve } from "h3-txikijs-adapter";

const app = new H3();
app.get("/", () => "hello world");

serve(app);
```

## Options
See `ServeOptions` in `index.ts`

## Limitation
1. Multipart form is currently not supported.
2. Only support UTF-8 encoding (limitation of txiki.js).

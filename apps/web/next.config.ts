import type { NextConfig } from "next";
/** localhostのGoogle popupだけに必要なHeader。Productionの能力を有効化しない。 */
const nextConfig: NextConfig = {
  /** @returns 開発/login専用Header。本番とTestには例外を設定しない。 */
  async headers() {
    return process.env.NODE_ENV==='development' ? [{source:'/login',headers:[{key:'Referrer-Policy',value:'no-referrer-when-downgrade'},{key:'Cross-Origin-Opener-Policy',value:'same-origin-allow-popups'}]}] : [];
  },
};
export default nextConfig;

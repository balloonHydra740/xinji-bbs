qrcodejs — 本地化副本
========================

来源   : https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js
上游   : https://github.com/davidshimjs/qrcodejs  (npm: qrcodejs@1.0.0)
许可证 : MIT
sha1   : 2d06c1f823f34c19981c6ae0b0eb0f5861c5e14b
字节数 : 19927

为什么放进仓库而不是继续用 CDN
-------------------------------
原来 index.html 从 jsdelivr.net / unpkg.com 加载这个库。那是跨站脚本请求，
uBlock Origin、AdGuard、Brave Shields 这类广告拦截器会按「第三方域名」
直接拦掉，用户在绑定 2FA 时会看到「追踪器被拦截」的提示。

这个库其实只在本地 canvas 上画二维码，不发任何网络请求、不做任何追踪，
属于典型的误报。但依赖 CDN 就意味着：
  * 被拦截时二维码画不出来（虽然已有手动输入密钥的降级，体验仍受损）；
  * 内网 / 离线 / 部分地区网络下同样加载失败；
  * 多一个第三方可用性依赖，且没有 SRI 时还有供应链风险。

改为同源加载（/vendor/qrcode.min.js）后，上面三个问题一并消失，
且静态资源由 Workers 的 ASSETS 直接托管，零额外成本。

升级方式
--------
需要换版本时，重新下载同名文件覆盖即可，然后同步更新上面的 sha1 与字节数。

    curl -L -o public/vendor/qrcode.min.js \
      https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js

若上游长期不再维护，可换用更现代的等价库（同样只需要一个 <script> 标签）：
  * qrcode-generator  (kazuhikoarase, MIT)
  * qrcode            (soldair, MIT，需打包器)

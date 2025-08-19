参考：https://github.com/yutian81/CF-tgfile/tree/main
更改：
1.DOMAIN变量不用设置，自动读取域名链接
2.文件管理页面增加缩略图和列表切换
3.去除必应壁纸和文件限制
部署要点：新建worker，要先设置D1数据库变量：DATABASE变量，否则会报错。
登录页面，首先变量ENABLE_AUTH要设为true，然后变量USERNAME和PASSWORD才能生效（可以改为ENABLE_AUTH默认为true，自动打开登录页面，然后设置USERNAME和PASSWORD，ENABLE_AUTH默认为false,那么USERNAME和PASSWORD不生效）

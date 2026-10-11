# MyTube 启动命令

项目位置：`D:\MyTube`

## 后端启动

```powershell
nvm use 22.12.0
cd D:\MyTube\backend
npm run start
```

后端地址：

- `http://localhost:5551`

## 前端开发服务启动

```powershell
nvm use 22.12.0
cd D:\MyTube\frontend
npm run dev
```

前端开发地址：

- `http://localhost:5556`

## 前端生产包构建

```powershell
nvm use 22.12.0
cd D:\MyTube\frontend
npm run build
```

说明：

- 构建后会生成 `D:\MyTube\frontend\dist`
- 这样后端 `http://localhost:5551` 也能直接返回完整页面，不会再因为缺少 `dist/index.html` 报 500

## 推荐使用方式

平时直接打开：

- `http://localhost:5556`

如果你想让后端 `5551` 也直接带页面，需要先执行一次：

```powershell
nvm use 22.12.0
cd D:\MyTube\frontend
npm run build
```

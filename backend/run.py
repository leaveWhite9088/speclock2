"""uvicorn 启动入口：在 backend/ 目录下执行 `python run.py`。"""

import uvicorn

if __name__ == "__main__":
    uvicorn.run("speclock2.app:create_app", factory=True, host="127.0.0.1", port=8000)

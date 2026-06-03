import { useNavigate } from "react-router-dom";

import { pagePaths, type Page } from "../types/navigation";

// 行内动作按钮统一的页面跳转入口：避免把 setPage 一路透传到每个页面。
// 返回的 go(page) 把内部 Page 标识转成真实路由路径并导航。
export function useGoToPage(): (page: Page) => void {
  const navigate = useNavigate();
  return (page: Page) => navigate(pagePaths[page]);
}

# 本地生活功能测试脚本包

## 运行前准备

安装依赖：

```powershell
py -m pip install requests
```

设置美团环境变量：

```powershell
$env:MT_APP_KEY="你的美团AppKey"
$env:MT_APP_SECRET="你的美团AppSecret"
```

如需测试千问品牌识别，再设置：

```powershell
$env:QWEN_API_KEY="你的千问API Key"
$env:QWEN_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
$env:QWEN_MODEL="qwen-plus"
```

---

## 01_category_recall_test.py

测试本地生活 5 个一级分类的多关键词召回、去重、过滤效果。

```powershell
py -u 01_category_recall_test.py --longitude 117.186361 --latitude 34.260681 --max-pages 1
```

只测酒店和休闲娱乐：

```powershell
py -u 01_category_recall_test.py --categories hotel,leisure
```

重点看：

```text
output_01_category_recall/00_分类召回与过滤测试报告.txt
```

---

## 02_hotel_brand_ai_test.py

测试酒店商品入库时调用千问识别我方品牌字段。

先运行 01 脚本，生成酒店商品：

```powershell
py -u 01_category_recall_test.py --categories hotel
```

再运行品牌识别：

```powershell
py -u 02_hotel_brand_ai_test.py --products output_01_category_recall/hotel_products_kept.json --brand-library brand_library_sample.json --limit 20
```

不调用千问，只用规则测试：

```powershell
py -u 02_hotel_brand_ai_test.py --products output_01_category_recall/hotel_products_kept.json --brand-library brand_library_sample.json --rule-only
```

重点看：

```text
output_02_hotel_brand_ai/02_酒店品牌AI识别测试报告.txt
```

---

## 03_hotel_brand_filter_test.py

测试酒店品牌多选筛选流程。最多选择 5 个品牌，品牌间是 OR 关系。

```powershell
py -u 03_hotel_brand_filter_test.py --brands 如家,亚朵 --brand-library brand_library_sample.json
```

不调用千问，只用规则测试：

```powershell
py -u 03_hotel_brand_filter_test.py --brands 如家,亚朵 --rule-only
```

重点看：

```text
output_03_hotel_brand_filter/06_酒店品牌多选筛选测试报告.txt
```

---

## 04_location_fallback_test.py

测试用户实时经纬度和 IP 城市兜底经纬度的差异。

```powershell
py -u 04_location_fallback_test.py --keyword 酒店 --real-longitude 117.186361 --real-latitude 34.260681 --city 徐州
```

只测兜底城市中心点：

```powershell
py -u 04_location_fallback_test.py --keyword 酒店 --city 徐州
```

重点看：

```text
output_04_location_fallback/01_定位与兜底测试报告.txt
```

---

## 输出结果判断

- 如果某分类保留商品数过少，说明该分类首版可能不适合上线。
- 如果过滤商品很多，说明关键词或过滤规则需要优化。
- 如果酒店品牌识别率低，需要补充品牌库别名。
- 如果品牌多选结果为空，需要检查品牌库别名、关键词召回和 AI 识别结果。
- 如果 IP 城市兜底也能返回商品，说明未授权定位时可以兜底展示，不会出现空白页。

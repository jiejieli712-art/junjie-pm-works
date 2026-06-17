package cn.laizhiyuantech;

import cn.hutool.json.JSONArray;
import cn.hutool.json.JSONObject;
import cn.hutool.json.JSONUtil;

import java.io.BufferedWriter;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.nio.file.*;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;

/**
 * 批量拉取 top20_city.csv 中 20 个城市下各区县的餐饮 POI。
 *
 * 使用方式：
 * 1. 把 top20_city.csv 放在项目根目录。
 * 2. 修改 API_KEY 为你的高德 Web服务 Key。
 * 3. 先将 LIMIT_DISTRICTS 改为 1 做小范围测试。
 * 4. 测试无误后，将 LIMIT_DISTRICTS 改回 0，执行全量采集。
 *
 * 输出：
 * output/by_district/城市名/城市名-区县名.csv
 * output/district_summary.csv
 * output/all_restaurants.csv
 */
public class AmapMultiDistrictRestaurantCrawler {

    // ========================= 必改配置 =========================
    private static final String API_KEY = System.getenv("AMAP_API_KEY");

    // 输入文件：放在项目根目录即可
    private static final String INPUT_CSV = "top20_city.csv";

    // 输出目录
    private static final String OUTPUT_DIR = "output";

    // ========================= 采集配置 =========================
    // 餐饮分类编码
    private static final String TYPES = "050000";

    // 关键词。餐饮 POI 建议保留“餐饮”
    private static final String KEYWORDS = "餐饮";

    // 搜索半径。越小越完整，但接口调用量越大。
    // 建议：先 2000 跑通；如发现 saturated_grid_count 很高，再改成 1200 或 800。
    private static final int RADIUS_METERS = 600;

    // 网格步长。理论上 <= R * sqrt(2) 可覆盖；这里用 1.35R 减少重叠与请求量。
    private static final double STEP_METERS = RADIUS_METERS * 1.35;

    // 边界缓冲扫描。
    // 原逻辑只扫描“圆心在区县内”的网格点，大步长时可能漏掉边界附近 POI。
    // 开启后：只要“搜索圆与区县边界有交集”，即使圆心在区县外，也会执行查询；
    // 最终仍通过 STRICT_ADCODE_FILTER 只保留当前区县 POI。
    private static final boolean ENABLE_BOUNDARY_BUFFER_SCAN = true;

    // 边界外扩距离。一般设置为 RADIUS_METERS 即可，表示外接矩形向外扩一圈搜索半径。
    private static final int BOUNDARY_BUFFER_METERS = RADIUS_METERS;

    // 每页条数
    private static final int PAGE_SIZE = 25;

    // 单个网格最多翻页数
    private static final int MAX_PAGE = 8;

    // 请求间隔，避免请求过快
    private static final int REQUEST_INTERVAL_MS = 300;

    // 失败重试次数
    private static final int MAX_RETRY = 3;

    // 是否严格只保留当前区县 adcode 下的 POI。
    // 建议开启，否则边界附近可能把相邻区县商家写入当前区县文件。
    private static final boolean STRICT_ADCODE_FILTER = true;

    // 是否调用详情接口。
    // true：字段更完整，但会对每个新 POI 额外请求一次接口，调用量大。
    // false：只使用 around 接口返回的基础字段，速度快。
    private static final boolean ENABLE_DETAIL_API = false;

    // 是否跳过已经生成过的区县文件，便于中断后续跑。
    private static final boolean SKIP_FINISHED_DISTRICT = true;

    // 测试限制：
    // 0 = 跑全部区县；
    // 1 = 只跑第 1 个区县；
    // 10 = 只跑前 10 个区县。
    private static final int LIMIT_DISTRICTS = 0;

    private static final String[] FOOD_SECOND_LEVEL_TYPES = {
            "050100", // 中餐厅
            "050200", // 外国餐厅
            "050300", // 快餐厅
            "050400", // 休闲餐饮场所
            "050500", // 咖啡厅
            "050600", // 茶艺馆
            "050700", // 冷饮店
            "050800", // 糕饼店
            "050900"  // 甜品店
    };

    // 中餐厅三级类目。核心城区里 050100 最容易饱和，所以再细拆。
    private static final String[] CHINESE_RESTAURANT_THIRD_LEVEL_TYPES = {
            "050101", // 综合酒楼
            "050102", // 四川菜
            "050103", // 广东菜
            "050104", // 山东菜
            "050105", // 江苏菜
            "050106", // 浙江菜
            "050107", // 上海菜
            "050108", // 湖南菜
            "050109", // 安徽菜
            "050110", // 福建菜
            "050111", // 北京菜
            "050112", // 湖北菜
            "050113", // 东北菜
            "050114", // 云贵菜
            "050115", // 西北菜
            "050116", // 老字号
            "050117", // 火锅店
            "050118", // 特色/地方风味餐厅
            "050119", // 海鲜酒楼
            "050120", // 中式素菜馆
            "050121", // 清真菜馆
            "050122", // 台湾菜
            "050123"  // 潮州菜
    };

    // ===========================================================

    private static final HttpClient CLIENT = HttpClient.newHttpClient();

    private static final String ALL_HEADER =
            "source_city_name,source_city_adcode,source_division_name,source_division_adcode,"
                    + "id,name,type,typecode,pname,cityname,adname,pcode,adcode,citycode,"
                    + "address,location,distance,tel,website,business_area,parent,scan_time\n";

    private static final String SUMMARY_HEADER =
            "city_name,city_admin_code,division_name,division_admin_code,status,poi_count,"
                    + "grid_count,api_request_count,error_count,saturated_grid_count,output_file,message,finished_at\n";

    public static void main(String[] args) throws Exception {
        Path input = Paths.get(INPUT_CSV);
        if (!Files.exists(input)) {
            System.err.println("未找到输入文件：" + input.toAbsolutePath());
            System.err.println("请把 top20_city.csv 放到项目根目录，或修改 INPUT_CSV。");
            return;
        }

        Path outputRoot = Paths.get(OUTPUT_DIR);
        Path byDistrictRoot = outputRoot.resolve("by_district");
        Files.createDirectories(byDistrictRoot);

        Path summaryPath = outputRoot.resolve("district_summary.csv");
        initCsvWithHeader(summaryPath, SUMMARY_HEADER);

        List<DistrictTask> tasks = loadDistrictTasks(input);
        if (tasks.isEmpty()) {
            System.err.println("CSV 中没有读取到有效区县，请检查 current_status 是否为“有效”，以及字段名是否正确。");
            return;
        }

        int cityCount = (int) tasks.stream().map(t -> t.cityAdminCode).distinct().count();
        System.out.println("已读取城市数：" + cityCount + "，区县数：" + tasks.size());

        int total = LIMIT_DISTRICTS > 0 ? Math.min(LIMIT_DISTRICTS, tasks.size()) : tasks.size();

        for (int i = 0; i < total; i++) {
            DistrictTask task = tasks.get(i);
            DistrictResult result = crawlDistrict(task, byDistrictRoot);
            appendSummary(summaryPath, result);
        }

        System.out.println("开始合并全部区县 CSV 到 all_restaurants.csv ...");
        mergeDistrictFiles(byDistrictRoot, outputRoot.resolve("all_restaurants.csv"));

        System.out.println("=========================================");
        System.out.println("全部任务结束。输出目录：" + outputRoot.toAbsolutePath());
        System.out.println("区县汇总：" + summaryPath.toAbsolutePath());
        System.out.println("总表：" + outputRoot.resolve("all_restaurants.csv").toAbsolutePath());
    }

    private static DistrictResult crawlDistrict(DistrictTask task, Path byDistrictRoot) {
        DistrictResult result = new DistrictResult(task);
        Path cityDir = byDistrictRoot.resolve(safeFileName(task.cityName));
        Path outFile = cityDir.resolve(safeFileName(task.cityName + "-" + task.divisionName) + ".csv");
        result.outputFile = outFile.toString();

        try {
            Files.createDirectories(cityDir);

            if (SKIP_FINISHED_DISTRICT && Files.exists(outFile) && Files.size(outFile) > ALL_HEADER.getBytes(StandardCharsets.UTF_8).length) {
                long count;
                try (java.util.stream.Stream<String> lines = Files.lines(outFile, StandardCharsets.UTF_8)) {
                    count = Math.max(0, lines.skip(1).count());
                }
                result.status = "SKIPPED";
                result.poiCount = (int) count;
                result.message = "已存在区县文件，跳过。如需重跑，删除该文件或关闭 SKIP_FINISHED_DISTRICT。";
                System.out.printf("⏭️ 跳过 %s-%s，已有 %d 条%n", task.cityName, task.divisionName, count);
                return result;
            }

            System.out.printf("%n========== [%s/%s] 开始采集：%s-%s（%s） ==========%n",
                    task.topRank, task.cityName, task.cityName, task.divisionName, task.divisionAdminCode);

            List<List<double[]>> polygons = fetchDistrictBoundary(task.divisionAdminCode);
            result.apiRequestCount++;

            if (polygons.isEmpty()) {
                result.status = "FAILED";
                result.message = "未获取到区县边界 polyline";
                System.err.println(result.message + "：" + task.cityName + "-" + task.divisionName);
                return result;
            }

            Bounds bounds = calcBounds(polygons);
            Bounds scanBounds = ENABLE_BOUNDARY_BUFFER_SCAN
                    ? expandBounds(bounds, BOUNDARY_BUFFER_METERS)
                    : bounds;

            Set<String> districtPoiIds = new HashSet<>();

            initCsvWithHeader(outFile, ALL_HEADER);

            try (BufferedWriter writer = Files.newBufferedWriter(outFile, StandardCharsets.UTF_8, StandardOpenOption.APPEND)) {
                double currentLat = scanBounds.minLat;

                while (currentLat <= scanBounds.maxLat) {
                    double currentLon = scanBounds.minLon;
                    double lonStepDegree = metersToLongitudeDegree(STEP_METERS, currentLat);

                    while (currentLon <= scanBounds.maxLon) {
                        if (shouldScanGrid(currentLon, currentLat, polygons)) {
                            result.gridCount++;
                            fetchPoisAroundGrid(task, currentLon, currentLat, writer, districtPoiIds, result);
                        }
                        currentLon += lonStepDegree;
                    }

                    currentLat += metersToLatitudeDegree(STEP_METERS);
                }
            }

            result.poiCount = districtPoiIds.size();
            result.status = "SUCCESS";
            result.message = result.saturatedGridCount > 0
                    ? "完成，但存在达到最大翻页数的网格，建议降低 RADIUS_METERS 后重跑该区县。"
                    : "完成";

            System.out.printf("✅ 完成：%s-%s，商家数：%d，网格数：%d，请求数：%d，异常数：%d，饱和网格：%d%n",
                    task.cityName, task.divisionName, result.poiCount, result.gridCount,
                    result.apiRequestCount, result.errorCount, result.saturatedGridCount);

            return result;
        } catch (Exception e) {
            result.status = "FAILED";
            result.message = e.getClass().getSimpleName() + ": " + safeMsg(e.getMessage());
            System.err.printf("❌ 区县失败：%s-%s，原因：%s%n", task.cityName, task.divisionName, result.message);
            return result;
        } finally {
            result.finishedAt = now();
        }
    }

    private static GridFetchResult fetchPoisAroundGridByType(DistrictTask task,
                                                             double lon,
                                                             double lat,
                                                             BufferedWriter writer,
                                                             Set<String> districtPoiIds,
                                                             DistrictResult result,
                                                             String typeCode) {
        GridFetchResult fetchResult = new GridFetchResult();

        for (int page = 1; page <= MAX_PAGE; page++) {
            String url = String.format(Locale.US,
                    "https://restapi.amap.com/v5/place/around?key=%s&keywords=&location=%.6f,%.6f&radius=%d&types=%s&page_size=%d&page_num=%d",
                    API_KEY,
                    lon,
                    lat,
                    RADIUS_METERS,
                    typeCode,
                    PAGE_SIZE,
                    page
            );

            try {
                JSONObject jsonObject = requestJson(url);
                result.apiRequestCount++;

                if (!"1".equals(jsonObject.getStr("status"))) {
                    result.errorCount++;
                    System.err.printf("周边搜索失败：%s-%s，type=%s，grid=[%.6f,%.6f]，page=%d，info=%s，infocode=%s%n",
                            task.cityName, task.divisionName, typeCode, lon, lat, page,
                            jsonObject.getStr("info"), jsonObject.getStr("infocode"));
                    break;
                }

                JSONArray pois = jsonObject.getJSONArray("pois");
                if (pois == null || pois.isEmpty()) {
                    break;
                }

                for (int i = 0; i < pois.size(); i++) {
                    JSONObject poi = pois.getJSONObject(i);
                    String poiId = poi.getStr("id");

                    if (isBlank(poiId)) {
                        continue;
                    }

                    if (districtPoiIds.contains(poiId)) {
                        continue;
                    }

                    JSONObject finalPoi = poi;

                    if (ENABLE_DETAIL_API) {
                        JSONObject detailPoi = fetchPoiDetail(poiId, result);
                        if (detailPoi != null) {
                            finalPoi = mergePoi(poi, detailPoi);
                        }
                    }

                    String adcode = finalPoi.getStr("adcode");
                    if (STRICT_ADCODE_FILTER && !task.divisionAdminCode.equals(adcode)) {
                        continue;
                    }

                    districtPoiIds.add(poiId);
                    writer.write(toPoiCsvLine(task, finalPoi));
                    fetchResult.addedCount++;
                }

                writer.flush();

                // 当前页不足 PAGE_SIZE，说明这个查询条件下已经没有下一页
                if (pois.size() < PAGE_SIZE) {
                    break;
                }

                // 到达最大页，且最后一页仍然满页，说明该 typeCode 下仍可能没取完
                if (page == MAX_PAGE && pois.size() >= PAGE_SIZE) {
                    fetchResult.saturated = true;
                    System.out.printf("⚠️ type=%s 可能未取完：%s-%s，grid=[%.6f, %.6f]，已到 MAX_PAGE=%d%n",
                            typeCode, task.cityName, task.divisionName, lon, lat, MAX_PAGE);
                }

            } catch (Exception e) {
                result.errorCount++;
                System.err.printf("请求异常：%s-%s，type=%s，grid=[%.6f,%.6f]，page=%d，error=%s%n",
                        task.cityName, task.divisionName, typeCode, lon, lat, page, safeMsg(e.getMessage()));
                sleepQuietly(REQUEST_INTERVAL_MS * 2);
            }
        }

        return fetchResult;
    }

    private static void fetchPoisAroundGrid(DistrictTask task,
                                            double lon,
                                            double lat,
                                            BufferedWriter writer,
                                            Set<String> districtPoiIds,
                                            DistrictResult result) {
        // 第一遍：按餐饮大类抓取
        GridFetchResult baseResult = fetchPoisAroundGridByType(
                task, lon, lat, writer, districtPoiIds, result, TYPES
        );

        // 如果大类没有饱和，说明这个网格基本取完了
        if (!baseResult.saturated) {
            return;
        }

        System.out.printf("🔁 饱和网格开始按餐饮子类补采：%s-%s，grid=[%.6f, %.6f]%n",
                task.cityName, task.divisionName, lon, lat);

        boolean stillSaturated = false;

        // 第二遍：按餐饮二级类目补采
        for (String typeCode : FOOD_SECOND_LEVEL_TYPES) {
            GridFetchResult subResult = fetchPoisAroundGridByType(
                    task, lon, lat, writer, districtPoiIds, result, typeCode
            );

            if (subResult.saturated) {
                stillSaturated = true;

                // 中餐厅最容易饱和，继续拆三级类目
                if ("050100".equals(typeCode)) {
                    System.out.printf("🔁 050100 中餐厅仍饱和，继续拆三级类目：%s-%s，grid=[%.6f, %.6f]%n",
                            task.cityName, task.divisionName, lon, lat);

                    for (String thirdTypeCode : CHINESE_RESTAURANT_THIRD_LEVEL_TYPES) {
                        GridFetchResult thirdResult = fetchPoisAroundGridByType(
                                task, lon, lat, writer, districtPoiIds, result, thirdTypeCode
                        );

                        if (thirdResult.saturated) {
                            System.out.printf("⚠️ 三级类目仍可能未取完：type=%s，%s-%s，grid=[%.6f, %.6f]%n",
                                    thirdTypeCode, task.cityName, task.divisionName, lon, lat);
                        }
                    }
                }
            }
        }

        if (stillSaturated) {
            result.saturatedGridCount++;
            System.out.printf("⚠️ 饱和网格已补采，但仍建议复核：%s-%s，grid=[%.6f, %.6f]%n",
                    task.cityName, task.divisionName, lon, lat);
        }
    }

    private static JSONObject fetchPoiDetail(String poiId, DistrictResult result) {
        String url = String.format(
                "https://restapi.amap.com/v5/place/detail?key=%s&id=%s&show_fields=business,photos",
                API_KEY,
                urlEncode(poiId)
        );

        try {
            JSONObject detailJson = requestJson(url);
            result.apiRequestCount++;

            if (!"1".equals(detailJson.getStr("status"))) {
                result.errorCount++;
                return null;
            }

            JSONArray pois = detailJson.getJSONArray("pois");
            if (pois == null || pois.isEmpty()) {
                return null;
            }

            return pois.getJSONObject(0);
        } catch (Exception e) {
            result.errorCount++;
            return null;
        }
    }

    private static List<List<double[]>> fetchDistrictBoundary(String adcode) throws IOException, InterruptedException {
        String url = String.format(
                "https://restapi.amap.com/v3/config/district?keywords=%s&subdistrict=0&extensions=all&key=%s",
                urlEncode(adcode),
                API_KEY
        );

        JSONObject jsonObject = requestJson(url);

        if (!"1".equals(jsonObject.getStr("status"))) {
            System.err.printf("行政区划接口失败：adcode=%s，info=%s，infocode=%s%n",
                    adcode, jsonObject.getStr("info"), jsonObject.getStr("infocode"));
            return Collections.emptyList();
        }

        JSONArray districts = jsonObject.getJSONArray("districts");
        if (districts == null || districts.isEmpty()) {
            return Collections.emptyList();
        }

        String polyline = districts.getJSONObject(0).getStr("polyline");
        if (isBlank(polyline)) {
            return Collections.emptyList();
        }

        return parsePolygons(polyline);
    }

    private static JSONObject requestJson(String url) throws IOException, InterruptedException {
        Exception last = null;

        for (int attempt = 1; attempt <= MAX_RETRY; attempt++) {
            try {
                HttpRequest request = HttpRequest.newBuilder()
                        .uri(URI.create(url))
                        .GET()
                        .build();

                HttpResponse<String> response = CLIENT.send(request, HttpResponse.BodyHandlers.ofString());

                // 核心：每次真实请求高德接口后都暂停，避免触发 QPS 限制
                sleepQuietly(REQUEST_INTERVAL_MS);

                String body = response.body();

                if (response.statusCode() >= 200 && response.statusCode() < 300 && !isBlank(body)) {
                    return JSONUtil.parseObj(body);
                }

                last = new IOException("HTTP " + response.statusCode() + ": " + body);
            } catch (Exception e) {
                last = e;

                // 失败后适当多等一会儿再重试
                sleepQuietly(REQUEST_INTERVAL_MS * attempt);
            }
        }

        if (last instanceof IOException) {
            throw (IOException) last;
        }
        if (last instanceof InterruptedException) {
            throw (InterruptedException) last;
        }
        throw new IOException("请求失败：" + safeMsg(last == null ? null : last.getMessage()));
    }

    private static List<DistrictTask> loadDistrictTasks(Path csvPath) throws IOException {
        Charset charset = detectCharset(csvPath);
        System.out.println("CSV 识别编码：" + charset.displayName());

        List<String> lines = Files.readAllLines(csvPath, charset);
        if (lines.isEmpty()) {
            return Collections.emptyList();
        }

        List<String> headers = parseCsvLine(lines.get(0));
        Map<String, Integer> index = new HashMap<>();
        for (int i = 0; i < headers.size(); i++) {
            index.put(headers.get(i).trim(), i);
        }

        List<DistrictTask> tasks = new ArrayList<>();

        for (int row = 1; row < lines.size(); row++) {
            if (isBlank(lines.get(row))) {
                continue;
            }

            List<String> cols = parseCsvLine(lines.get(row));

            String status = getCol(cols, index, "current_status");
            if (!isBlank(status) && !"有效".equals(status.trim())) {
                continue;
            }

            DistrictTask task = new DistrictTask();
            task.topRank = getCol(cols, index, "top_rank");
            task.province = getCol(cols, index, "province");
            task.cityName = getCol(cols, index, "city_name");
            task.cityAdminCode = getCol(cols, index, "city_admin_code");
            task.divisionName = getCol(cols, index, "division_name");
            task.divisionType = getCol(cols, index, "division_type");
            task.divisionAdminCode = cleanAdcode(getCol(cols, index, "division_admin_code"));

            if (isBlank(task.cityName) || isBlank(task.divisionName) || isBlank(task.divisionAdminCode)) {
                continue;
            }

            tasks.add(task);
        }

        return tasks;
    }

    private static String toPoiCsvLine(DistrictTask task, JSONObject poi) {
        return String.join(",",
                csv(task.cityName),
                csv(task.cityAdminCode),
                csv(task.divisionName),
                csv(task.divisionAdminCode),
                csv(poi.getStr("id")),
                csv(poi.getStr("name")),
                csv(poi.getStr("type")),
                csv(poi.getStr("typecode")),
                csv(poi.getStr("pname")),
                csv(poi.getStr("cityname")),
                csv(poi.getStr("adname")),
                csv(poi.getStr("pcode")),
                csv(poi.getStr("adcode")),
                csv(poi.getStr("citycode")),
                csv(poi.getStr("address")),
                csv(poi.getStr("location")),
                csv(poi.getStr("distance")),
                csv(poi.getStr("tel")),
                csv(poi.getStr("website")),
                csv(poi.getStr("business_area")),
                csv(poi.getStr("parent")),
                csv(now())
        ) + "\n";
    }

    private static void appendSummary(Path summaryPath, DistrictResult r) throws IOException {
        try (BufferedWriter writer = Files.newBufferedWriter(summaryPath, StandardCharsets.UTF_8, StandardOpenOption.APPEND)) {
            writer.write(String.join(",",
                    csv(r.task.cityName),
                    csv(r.task.cityAdminCode),
                    csv(r.task.divisionName),
                    csv(r.task.divisionAdminCode),
                    csv(r.status),
                    csv(String.valueOf(r.poiCount)),
                    csv(String.valueOf(r.gridCount)),
                    csv(String.valueOf(r.apiRequestCount)),
                    csv(String.valueOf(r.errorCount)),
                    csv(String.valueOf(r.saturatedGridCount)),
                    csv(r.outputFile),
                    csv(r.message),
                    csv(r.finishedAt)
            ) + "\n");
        }
    }

    private static void mergeDistrictFiles(Path byDistrictRoot, Path allPath) throws IOException {
        initCsvWithHeader(allPath, ALL_HEADER);

        try (BufferedWriter allWriter = Files.newBufferedWriter(allPath, StandardCharsets.UTF_8, StandardOpenOption.APPEND)) {
            if (!Files.exists(byDistrictRoot)) {
                return;
            }

            Files.walk(byDistrictRoot)
                    .filter(path -> path.toString().endsWith(".csv"))
                    .forEach(path -> {
                        try {
                            List<String> lines = Files.readAllLines(path, StandardCharsets.UTF_8);
                            for (int i = 1; i < lines.size(); i++) {
                                allWriter.write(lines.get(i));
                                allWriter.write("\n");
                            }
                        } catch (IOException e) {
                            throw new UncheckedIOException(e);
                        }
                    });
        }
    }

    private static void initCsvWithHeader(Path path, String header) throws IOException {
        Files.createDirectories(path.getParent());
        try (BufferedWriter writer = Files.newBufferedWriter(path, StandardCharsets.UTF_8)) {
            // 写 BOM，方便 Excel 直接打开不乱码
            writer.write('\ufeff');
            writer.write(header);
        }
    }

    private static JSONObject mergePoi(JSONObject base, JSONObject detail) {
        JSONObject merged = JSONUtil.parseObj(base.toString());
        for (String key : detail.keySet()) {
            Object value = detail.get(key);
            if (value != null && !isBlank(String.valueOf(value))) {
                merged.set(key, value);
            }
        }
        return merged;
    }

    private static List<List<double[]>> parsePolygons(String polyline) {
        List<List<double[]>> polygons = new ArrayList<>();
        String[] polygonsStr = polyline.split("\\|");

        for (String polyStr : polygonsStr) {
            String[] pointsStr = polyStr.split(";");
            List<double[]> polygon = new ArrayList<>();

            for (String ptStr : pointsStr) {
                String[] lngLat = ptStr.split(",");
                if (lngLat.length == 2) {
                    try {
                        polygon.add(new double[]{
                                Double.parseDouble(lngLat[0]),
                                Double.parseDouble(lngLat[1])
                        });
                    } catch (NumberFormatException ignore) {
                        // 跳过异常坐标点
                    }
                }
            }

            if (!polygon.isEmpty()) {
                polygons.add(polygon);
            }
        }

        return polygons;
    }

    private static Bounds calcBounds(List<List<double[]>> polygons) {
        Bounds b = new Bounds();
        for (List<double[]> polygon : polygons) {
            for (double[] p : polygon) {
                b.minLon = Math.min(b.minLon, p[0]);
                b.maxLon = Math.max(b.maxLon, p[0]);
                b.minLat = Math.min(b.minLat, p[1]);
                b.maxLat = Math.max(b.maxLat, p[1]);
            }
        }
        return b;
    }

    /**
     * 扩展扫描外接矩形：向四周外扩 bufferMeters。
     * 目的：允许边界外一圈圆心参与查询，避免大步长时行政边界附近漏覆盖。
     */
    private static Bounds expandBounds(Bounds bounds, double bufferMeters) {
        Bounds expanded = new Bounds();

        double midLat = (bounds.minLat + bounds.maxLat) / 2.0;
        double lonBufferDegree = metersToLongitudeDegree(bufferMeters, midLat);
        double latBufferDegree = metersToLatitudeDegree(bufferMeters);

        expanded.minLon = bounds.minLon - lonBufferDegree;
        expanded.maxLon = bounds.maxLon + lonBufferDegree;
        expanded.minLat = bounds.minLat - latBufferDegree;
        expanded.maxLat = bounds.maxLat + latBufferDegree;

        return expanded;
    }

    /**
     * 判断当前格点是否需要扫描。
     *
     * 旧逻辑：只有圆心在行政区内才扫描。
     * 新逻辑：如果开启边界缓冲，只要“以该格点为圆心的搜索圆”和行政区有交集，就扫描。
     */
    private static boolean shouldScanGrid(double lon, double lat, List<List<double[]>> polygons) {
        if (!ENABLE_BOUNDARY_BUFFER_SCAN) {
            return isPointInPolygons(lon, lat, polygons);
        }

        return isCircleIntersectsPolygons(lon, lat, RADIUS_METERS, polygons);
    }

    /**
     * 判断搜索圆是否与任意行政区多边形有交集。
     * 满足以下任一条件即认为有交集：
     * 1. 圆心在多边形内；
     * 2. 多边形顶点落入圆内；
     * 3. 圆心到多边形任意边的最短距离 <= 半径。
     */
    private static boolean isCircleIntersectsPolygons(double lon, double lat, double radiusMeters, List<List<double[]>> polygons) {
        for (List<double[]> polygon : polygons) {
            if (isPointInPolygon(lon, lat, polygon)) {
                return true;
            }

            for (int i = 0; i < polygon.size(); i++) {
                double[] current = polygon.get(i);
                double[] next = polygon.get((i + 1) % polygon.size());

                if (distanceMeters(lon, lat, current[0], current[1]) <= radiusMeters) {
                    return true;
                }

                if (distancePointToSegmentMeters(lon, lat, current[0], current[1], next[0], next[1]) <= radiusMeters) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * 两个经纬度点之间的近似距离，单位：米。
     * 对本脚本的百米/千米级网格扫描足够准确。
     */
    private static double distanceMeters(double lon1, double lat1, double lon2, double lat2) {
        double meanLat = Math.toRadians((lat1 + lat2) / 2.0);
        double dx = (lon2 - lon1) * 111132.0 * Math.cos(meanLat);
        double dy = (lat2 - lat1) * 111132.0;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /**
     * 计算点 P 到线段 AB 的近似最短距离，单位：米。
     * 以 P 点为局部坐标原点，把经纬度差换算为米后做点到线段距离计算。
     */
    private static double distancePointToSegmentMeters(double pLon, double pLat,
                                                       double aLon, double aLat,
                                                       double bLon, double bLat) {
        double meanLat = Math.toRadians(pLat);

        double ax = (aLon - pLon) * 111132.0 * Math.cos(meanLat);
        double ay = (aLat - pLat) * 111132.0;
        double bx = (bLon - pLon) * 111132.0 * Math.cos(meanLat);
        double by = (bLat - pLat) * 111132.0;

        double abx = bx - ax;
        double aby = by - ay;
        double abLen2 = abx * abx + aby * aby;

        if (abLen2 == 0) {
            return Math.sqrt(ax * ax + ay * ay);
        }

        double t = -((ax * abx) + (ay * aby)) / abLen2;
        t = Math.max(0.0, Math.min(1.0, t));

        double closestX = ax + t * abx;
        double closestY = ay + t * aby;

        return Math.sqrt(closestX * closestX + closestY * closestY);
    }

    private static boolean isPointInPolygons(double lon, double lat, List<List<double[]>> polygons) {
        for (List<double[]> polygon : polygons) {
            if (isPointInPolygon(lon, lat, polygon)) {
                return true;
            }
        }
        return false;
    }

    private static boolean isPointInPolygon(double lon, double lat, List<double[]> polygon) {
        boolean inside = false;
        int j = polygon.size() - 1;

        for (int i = 0; i < polygon.size(); i++) {
            double[] pi = polygon.get(i);
            double[] pj = polygon.get(j);

            if ((pi[1] > lat) != (pj[1] > lat)
                    && (lon < (pj[0] - pi[0]) * (lat - pi[1]) / (pj[1] - pi[1]) + pi[0])) {
                inside = !inside;
            }
            j = i;
        }

        return inside;
    }

    private static double metersToLatitudeDegree(double meters) {
        return meters / 111132.0;
    }

    private static double metersToLongitudeDegree(double meters, double lat) {
        double radians = Math.toRadians(lat);
        return meters / (111132.0 * Math.cos(radians));
    }

    private static String urlEncode(String value) {
        try {
            return URLEncoder.encode(value, StandardCharsets.UTF_8.name());
        } catch (Exception e) {
            return value;
        }
    }

    private static String csv(String value) {
        if (value == null) {
            value = "";
        }
        value = value.replace("\r", " ").replace("\n", " ");
        return "\"" + value.replace("\"", "\"\"") + "\"";
    }

    private static String cleanAdcode(String code) {
        if (code == null) {
            return "";
        }
        code = code.trim();
        if (code.endsWith(".0")) {
            code = code.substring(0, code.length() - 2);
        }
        return code;
    }

    private static String getCol(List<String> cols, Map<String, Integer> index, String key) {
        Integer i = index.get(key);
        if (i == null || i < 0 || i >= cols.size()) {
            return "";
        }
        return cols.get(i).trim();
    }

    /**
     * 简单 CSV 行解析，支持英文逗号和双引号转义。
     */
    private static List<String> parseCsvLine(String line) {
        List<String> result = new ArrayList<>();
        StringBuilder cell = new StringBuilder();
        boolean inQuotes = false;

        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);

            if (c == '"') {
                if (inQuotes && i + 1 < line.length() && line.charAt(i + 1) == '"') {
                    cell.append('"');
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (c == ',' && !inQuotes) {
                result.add(cell.toString());
                cell.setLength(0);
            } else {
                cell.append(c);
            }
        }

        result.add(cell.toString());
        return result;
    }

    private static Charset detectCharset(Path path) throws IOException {
        byte[] bytes = Files.readAllBytes(path);

        if (bytes.length >= 3
                && (bytes[0] & 0xff) == 0xef
                && (bytes[1] & 0xff) == 0xbb
                && (bytes[2] & 0xff) == 0xbf) {
            return StandardCharsets.UTF_8;
        }

        CharsetDecoder utf8Decoder = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);

        try {
            utf8Decoder.decode(ByteBuffer.wrap(bytes));
            return StandardCharsets.UTF_8;
        } catch (CharacterCodingException e) {
            return Charset.forName("GBK");
        }
    }

    private static String safeFileName(String name) {
        if (name == null) {
            return "unknown";
        }
        return name.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
    }

    private static boolean isBlank(String s) {
        return s == null || s.trim().isEmpty() || "[]".equals(s.trim()) || "{}".equals(s.trim());
    }

    private static String safeMsg(String msg) {
        return msg == null ? "" : msg.replace("\r", " ").replace("\n", " ");
    }

    private static String now() {
        return LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss"));
    }

    private static void sleepQuietly(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignore) {
            Thread.currentThread().interrupt();
        }
    }

    private static class DistrictTask {
        String topRank;
        String province;
        String cityName;
        String cityAdminCode;
        String divisionName;
        String divisionType;
        String divisionAdminCode;
    }

    private static class DistrictResult {
        final DistrictTask task;
        String status = "UNKNOWN";
        int poiCount = 0;
        int gridCount = 0;
        int apiRequestCount = 0;
        int errorCount = 0;
        int saturatedGridCount = 0;
        String outputFile = "";
        String message = "";
        String finishedAt = now();

        DistrictResult(DistrictTask task) {
            this.task = task;
        }
    }

    private static class GridFetchResult {
        boolean saturated = false;
        int addedCount = 0;
    }

    private static class Bounds {
        double minLon = Double.MAX_VALUE;
        double maxLon = -Double.MAX_VALUE;
        double minLat = Double.MAX_VALUE;
        double maxLat = -Double.MAX_VALUE;
    }
}


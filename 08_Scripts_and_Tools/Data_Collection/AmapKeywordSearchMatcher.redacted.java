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
 * 淘宝闪购商家 -> 高德 POI 关键词搜索批量匹配脚本。
 *
 * 输入：
 *   input_keyword_json/徐州市.json              // 城市级，全市搜索
 *   input_keyword_json/徐州市-铜山区.json       // 区县级，指定区县搜索
 *   input_keyword_json/徐州市-鼓楼区.json
 *
 * 输入 JSON 支持：
 *   { "shops": [...] }
 *   { "rows": [...] }
 *
 * 处理逻辑：
 *   1. 读取每个区县 JSON 文件。
 *   2. 从文件名解析城市和区县：
 *      - “徐州市.json” => city=徐州市，district=全市，region=徐州市
 *      - “徐州市-铜山区.json” => city=徐州市，district=铜山区，region=徐州市铜山区。
 *   3. 对每个淘宝闪购商家，以 shop_name 作为 keywords 调用高德关键词搜索 /v5/place/text。
 *   4. 不设置 types，避免因 POI 类型限制导致搜索不到。
 *   5. 使用 region=城市+区县，并 city_limit=true 限定区域。
 *   6. 对返回候选做名称相似度和区县匹配打分，选出最佳 POI。
 *   7. 可选调用 /v5/place/detail 获取详情。
 *   8. 输出每个区县 CSV、JSON，同时输出汇总 CSV 和 summary。
 */
public class AmapKeywordSearchMatcher {

    // ========================= 必改配置 =========================
    private static final String API_KEY = System.getenv("AMAP_API_KEY");
    private static final String INPUT_DIR = "input_keyword_json";
    private static final String OUTPUT_DIR = "keyword_output";

    // ========================= 高德接口配置 =========================
    // 关键字搜索接口：不要传 types
    private static final String TEXT_SEARCH_URL = "https://restapi.amap.com/v5/place/text";

    // ID 详情接口：用于返回详情
    private static final String DETAIL_URL = "https://restapi.amap.com/v5/place/detail";

    // 高德详情字段。business/photos/children
    private static final String SHOW_FIELDS = "business,children,photos";

    // 每页数量
    private static final int PAGE_SIZE = 25;

    // 每个店铺关键词最多翻几页
    private static final int MAX_SEARCH_PAGES = 2;

    // 是否调用 ID 详情接口
    private static final boolean ENABLE_DETAIL_API = true;

    // 是否只接受当前区县 adname 匹配的 POI。
    private static final boolean STRICT_DISTRICT_FILTER = true;

    // 最低匹配分。低于该分判为 NOT_MATCHED。
    private static final int MIN_MATCH_SCORE = 55;

    // 请求间隔，避免 QPS 超限
    private static final int REQUEST_INTERVAL_MS = 50;

    // 失败重试次数
    private static final int MAX_RETRY = 3;

    // 单次运行请求预算，避免把日额度打空；0 表示不限制
    private static final int MAX_API_REQUESTS_PER_RUN = 0;

    // 测试限制
    private static final int LIMIT_FILES = 0;

    // 是否启用本地缓存
    private static final boolean ENABLE_CACHE = true;
    private static final String CACHE_DIR = "keyword_cache";

    private static final boolean ENABLE_RESUME = true;
    private static final String PROGRESS_DIR = "keyword_progress";

    // ========================= 全局一对一匹配配置 =========================
    // true：先收集所有淘宝店铺的高德候选，再按分数从高到低做全局一对一分配；
    // 避免多个淘宝门店绑定到同一个高德 POI，也避免低分店铺先占用高分店铺的候选。
    private static final boolean ENABLE_GLOBAL_ONE_TO_ONE_MATCH = true;

    // 每个淘宝店铺最多保留多少个高德候选进入全局分配。
    // 数值越大，匹配机会越多，但内存和本地计算更多；不会额外增加接口调用，除非你同步提高 MAX_SEARCH_PAGES。
    private static final int MAX_CANDIDATES_PER_SHOP_FOR_GLOBAL_MATCH = 8;

    // 全局匹配模式下建议从头重建输出，避免旧的“逐条贪心匹配”结果残留。
    private static final boolean REGENERATE_OUTPUT_FOR_GLOBAL_MATCH = true;

    // ===========================================================

    private static final HttpClient CLIENT = HttpClient.newHttpClient();
    private static int totalApiRequestsThisRun = 0;
    private static boolean dailyLimitReached = false;

    private static final String CSV_HEADER =
            "source_file,source_city_name,source_district_name,source_region,"
                    + "tb_index,tb_shop_name,tb_shop_id,tb_origin_store_id,tb_en_ele_shop_id,tb_md5_shop_id,"
                    + "tb_rate,tb_monthly_sale_text,tb_monthly_sale_number,tb_delivery_price,tb_delivery_price_yuan,"
                    + "tb_commission_rate,tb_commission,tb_tag_list,tb_recommend_reasons,"
                    + "match_status,match_score,match_reason,candidate_count,"
                    + "amap_id,amap_name,amap_type,amap_typecode,amap_pname,amap_cityname,amap_adname,"
                    + "amap_pcode,amap_adcode,amap_citycode,amap_address,amap_location,"
                    + "amap_tel,amap_business_area,amap_rating,amap_cost,amap_opentime_today,amap_opentime_week,"
                    + "raw_keyword_json,raw_detail_json,matched_at\n";

    private static final String SUMMARY_HEADER =
            "source_file,city_name,district_name,total_shops,matched_count,unmatched_count,error_count,api_request_count,output_csv,output_json,finished_at\n";

    private static final int CSV_MATCH_STATUS_INDEX = 19;

    public static void main(String[] args) throws Exception {
        Path inputDir = Paths.get(INPUT_DIR);
        if (!Files.exists(inputDir)) {
            Files.createDirectories(inputDir);
            System.err.println("未找到输入目录，已创建：" + inputDir.toAbsolutePath());
            System.err.println("请把区县 JSON 文件放入该目录，例如：徐州市-铜山区.json");
            return;
        }

        Path outputRoot = Paths.get(OUTPUT_DIR);
        Path byDistrictRoot = outputRoot.resolve("by_district");
        Files.createDirectories(byDistrictRoot);

        Path summaryPath = outputRoot.resolve("summary.csv");
        initCsvWithHeader(summaryPath, SUMMARY_HEADER);

        List<Path> files = listJsonFiles(inputDir);
        if (files.isEmpty()) {
            System.err.println("输入目录中没有 JSON 文件：" + inputDir.toAbsolutePath());
            return;
        }

        int total = LIMIT_FILES > 0 ? Math.min(LIMIT_FILES, files.size()) : files.size();
        System.out.println("发现 JSON 文件数：" + files.size() + "，本次处理：" + total);

        List<DistrictSummary> summaries = new ArrayList<>();

        for (int i = 0; i < total; i++) {
            if (dailyLimitReached) {
                System.err.println("已触发高德日调用量上限，停止后续文件处理。");
                break;
            }
            Path file = files.get(i);
            DistrictSummary summary = processDistrictFile(file, byDistrictRoot);
            summaries.add(summary);
            appendSummary(summaryPath, summary);
        }

        if (dailyLimitReached) {
            System.err.println("Stopped due to Amap daily quota limit. Current outputs are partial.");
        }

        System.out.println("开始合并全部区县 CSV 到 all_matched.csv ...");
        mergeDistrictFiles(byDistrictRoot, outputRoot.resolve("all_matched.csv"));

        System.out.println("开始合并全部区县 JSON 到 all_matched.json ...");
        mergeDistrictJsonFiles(byDistrictRoot, outputRoot.resolve("all_matched.json"));

        System.out.println("开始输出 summary.json ...");
        writeSummaryJson(outputRoot.resolve("summary.json"), summaries);

        System.out.println("=========================================");
        System.out.println("全部任务结束。输出目录：" + outputRoot.toAbsolutePath());
        System.out.println("汇总表 CSV：" + summaryPath.toAbsolutePath());
        System.out.println("汇总表 JSON：" + outputRoot.resolve("summary.json").toAbsolutePath());
        System.out.println("总表 CSV：" + outputRoot.resolve("all_matched.csv").toAbsolutePath());
        System.out.println("总表 JSON：" + outputRoot.resolve("all_matched.json").toAbsolutePath());
        System.out.println("本次高德请求数：" + totalApiRequestsThisRun);
    }

    private static DistrictSummary processDistrictFile(Path inputFile, Path byDistrictRoot) {
        DistrictContext ctx = parseDistrictContext(inputFile);
        DistrictSummary summary = new DistrictSummary();
        summary.sourceFile = inputFile.getFileName().toString();
        summary.cityName = ctx.cityName;
        summary.districtName = ctx.districtName;

        Path cityDir = byDistrictRoot.resolve(safeFileName(ctx.cityName));
        Path csvPath = cityDir.resolve(safeFileName(ctx.outputName) + "_amap_keyword.csv");
        Path jsonPath = cityDir.resolve(safeFileName(ctx.outputName) + "_amap_keyword.json");
        Path progressDir = Paths.get(PROGRESS_DIR);
        Path progressPath = progressDir.resolve(safeFileName(ctx.outputName) + ".progress.json");
        Path progressRowsPath = progressDir.resolve(safeFileName(ctx.outputName) + ".rows.jsonl");
        summary.outputCsv = csvPath.toString();
        summary.outputJson = jsonPath.toString();

        int startApiCount = totalApiRequestsThisRun;

        try {
            Files.createDirectories(cityDir);
            Files.createDirectories(progressDir);

            JSONObject inputJson = readJson(inputFile);
            JSONArray shops = getShopArray(inputJson);
            summary.totalShops = shops.size();

            if (ENABLE_GLOBAL_ONE_TO_ONE_MATCH) {
                return processDistrictFileWithGlobalOneToOne(
                        inputFile, ctx, summary, shops, csvPath, jsonPath,
                        progressPath, progressRowsPath, startApiCount
                );
            }

            // 保留原逐条匹配流程，默认不会走到这里。仅作为兼容开关。
            ResumeSnapshot resume = ENABLE_RESUME
                    ? loadResumeSnapshot(progressPath, progressRowsPath, csvPath, shops.size())
                    : new ResumeSnapshot();

            summary.matchedCount = resume.matchedCount;
            summary.unmatchedCount = resume.unmatchedCount;
            summary.errorCount = resume.errorCount;
            summary.apiRequestCount = resume.apiRequestCount;
            int outputRowCount = resume.outputRowCount;

            if (resume.nextIndex <= 0 || !Files.exists(csvPath)) {
                initCsvWithHeader(csvPath, CSV_HEADER);
                deleteIfExists(progressRowsPath);
                outputRowCount = 0;
            } else {
                System.out.printf("检测到断点: %s from %d/%d%n",
                        ctx.outputName, resume.nextIndex, shops.size());
            }

            System.out.printf("%n========== 开始处理：%s，region=%s，商家数：%d ==========%n",
                    ctx.outputName, ctx.region, shops.size());

            try (BufferedWriter writer = Files.newBufferedWriter(csvPath, StandardCharsets.UTF_8, StandardOpenOption.APPEND)) {
                for (int i = resume.nextIndex; i < shops.size(); i++) {
                    if (dailyLimitReached) {
                        break;
                    }

                    JSONObject tbShop = shops.getJSONObject(i);
                    String shopName = firstNonBlank(tbShop.getStr("shop_name"), tbShop.getStr("title"), tbShop.getStr("name"));
                    if (isBlank(shopName)) {
                        summary.errorCount++;
                        outputRowCount++;
                        saveResumeSnapshot(progressPath, buildResumeSnapshot(summary,
                                i + 1, shops.size(), outputRowCount, summary.apiRequestCount + (totalApiRequestsThisRun - startApiCount)));
                        continue;
                    }

                    MatchResult match = matchOneShop(ctx, tbShop, shopName);
                    if ("MATCHED".equals(match.status)) {
                        summary.matchedCount++;
                    } else if ("ERROR".equals(match.status)) {
                        summary.errorCount++;
                    } else {
                        summary.unmatchedCount++;
                    }

                    writer.write(toCsvLine(ctx, inputFile.getFileName().toString(), i + 1, tbShop, match));
                    JSONObject row = toOutputJson(ctx, inputFile.getFileName().toString(), i + 1, tbShop, match);
                    appendProgressRow(progressRowsPath, row);
                    outputRowCount++;
                    saveResumeSnapshot(progressPath, buildResumeSnapshot(summary,
                            i + 1, shops.size(), outputRowCount, summary.apiRequestCount + (totalApiRequestsThisRun - startApiCount)));

                    if ((i + 1) % 20 == 0) {
                        System.out.printf("进度：%s %d/%d，匹配=%d，未匹配=%d，请求数=%d%n",
                                ctx.outputName, i + 1, shops.size(),
                                summary.matchedCount, summary.unmatchedCount, summary.apiRequestCount + (totalApiRequestsThisRun - startApiCount));
                    }
                }
            }

            summary.apiRequestCount = summary.apiRequestCount + (totalApiRequestsThisRun - startApiCount);
            summary.finishedAt = now();
            summary.completed = !dailyLimitReached
                    && (summary.matchedCount + summary.unmatchedCount + summary.errorCount >= summary.totalShops);

            writeDistrictJsonFile(jsonPath, inputFile.getFileName().toString(), ctx, summary, progressRowsPath);

            if (summary.completed) {
                deleteIfExists(progressPath);
            }

            System.out.printf("✅ 完成：%s，总数=%d，匹配=%d，未匹配=%d，异常=%d，请求=%d%n",
                    ctx.outputName, summary.totalShops, summary.matchedCount,
                    summary.unmatchedCount, summary.errorCount, summary.apiRequestCount);

            return summary;
        } catch (Exception e) {
            summary.errorCount++;
            summary.apiRequestCount = totalApiRequestsThisRun - startApiCount;
            summary.finishedAt = now();
            System.err.printf("❌ 文件处理失败：%s，原因：%s%n", inputFile.getFileName(), safeMsg(e.getMessage()));
            return summary;
        }
    }

    private static DistrictSummary processDistrictFileWithGlobalOneToOne(Path inputFile,
                                                                         DistrictContext ctx,
                                                                         DistrictSummary summary,
                                                                         JSONArray shops,
                                                                         Path csvPath,
                                                                         Path jsonPath,
                                                                         Path progressPath,
                                                                         Path progressRowsPath,
                                                                         int startApiCount) throws IOException {
        // 全局一对一匹配必须重建输出，不能沿用旧的“逐条贪心匹配”历史结果。
        if (REGENERATE_OUTPUT_FOR_GLOBAL_MATCH) {
            initCsvWithHeader(csvPath, CSV_HEADER);
            deleteIfExists(progressPath);
            deleteIfExists(progressRowsPath);
        }

        System.out.printf("%n========== 开始全局一对一匹配：%s，region=%s，商家数：%d ==========%n",
                ctx.outputName, ctx.region, shops.size());

        ShopMatchState[] states = new ShopMatchState[shops.size()];
        List<CandidateEdge> allEdges = new ArrayList<>();

        // 第一阶段：只做关键词搜索和候选打分，不调用详情，不立刻占用 POI。
        for (int i = 0; i < shops.size(); i++) {
            if (dailyLimitReached) {
                break;
            }

            JSONObject tbShop = shops.getJSONObject(i);
            String shopName = firstNonBlank(tbShop.getStr("shop_name"), tbShop.getStr("title"), tbShop.getStr("name"));

            ShopMatchState state = new ShopMatchState();
            state.index = i;
            state.shopName = shopName;
            states[i] = state;

            if (isBlank(shopName)) {
                state.status = "ERROR";
                state.reason = "淘宝店铺名称为空";
                summary.errorCount++;
                continue;
            }

            try {
                JSONObject searchJson = searchKeyword(ctx, shopName);

                if (!"1".equals(searchJson.getStr("status"))) {
                    String info = searchJson.getStr("info");
                    String infocode = searchJson.getStr("infocode");
                    state.status = "ERROR";
                    state.reason = "高德关键词搜索失败：" + info + "/" + infocode;
                    summary.errorCount++;
                    handleLimitIfNeeded(info, infocode);
                    continue;
                }

                JSONArray candidates = collectCandidates(searchJson);
                state.candidateCount = candidates.size();

                List<CandidateEdge> edges = buildCandidateEdges(ctx, shopName, candidates, i, state);
                allEdges.addAll(edges);

                if (edges.isEmpty()) {
                    state.status = "NOT_MATCHED";
                    state.reason = state.bestScore > 0
                            ? "无达到阈值的候选，最高分=" + state.bestScore + "; " + state.bestReason
                            : "高德无候选或候选被区县过滤";
                } else {
                    state.status = "PENDING";
                    state.reason = "已进入全局一对一候选池，候选数=" + edges.size();
                }
            } catch (Exception e) {
                state.status = "ERROR";
                state.reason = e.getClass().getSimpleName() + ": " + safeMsg(e.getMessage());
                summary.errorCount++;
            }

            if ((i + 1) % 100 == 0 || i + 1 == shops.size()) {
                System.out.printf("候选收集：%s %d/%d，候选边=%d，请求数=%d%n",
                        ctx.outputName, i + 1, shops.size(), allEdges.size(),
                        totalApiRequestsThisRun - startApiCount);
            }
        }

        // 如果配额中途耗尽，保留缓存，下次重跑会优先读缓存。
        if (dailyLimitReached) {
            summary.apiRequestCount = totalApiRequestsThisRun - startApiCount;
            summary.finishedAt = now();
            summary.completed = false;
            return summary;
        }

        // 第二阶段：按分数从高到低做全局一对一分配。
        allEdges.sort((a, b) -> {
            int scoreCompare = Integer.compare(b.score, a.score);
            if (scoreCompare != 0) {
                return scoreCompare;
            }
            int nameCompare = Integer.compare(b.nameScore, a.nameScore);
            if (nameCompare != 0) {
                return nameCompare;
            }
            return Integer.compare(a.shopIndex, b.shopIndex);
        });

        Set<Integer> assignedShopIndexes = new HashSet<>();
        Set<String> usedAmapIds = new HashSet<>();

        for (CandidateEdge edge : allEdges) {
            if (assignedShopIndexes.contains(edge.shopIndex)) {
                continue;
            }
            if (usedAmapIds.contains(edge.amapId)) {
                ShopMatchState s = states[edge.shopIndex];
                if (s != null && isBlank(s.rejectedReason)) {
                    s.rejectedReason = "候选 POI 已被更高分淘宝店铺占用，amap_id=" + edge.amapId + ", score=" + edge.score;
                }
                continue;
            }

            ShopMatchState state = states[edge.shopIndex];
            if (state == null) {
                continue;
            }

            state.status = "MATCHED";
            state.assignedAmapId = edge.amapId;
            state.score = edge.score;
            state.reason = "全局一对一分配成功；" + edge.reason;
            assignedShopIndexes.add(edge.shopIndex);
            usedAmapIds.add(edge.amapId);
        }

        // 第三阶段：按最终分配结果输出；只对最终 MATCHED 的 POI 调详情。
        int outputRowCount = 0;
        try (BufferedWriter writer = Files.newBufferedWriter(csvPath, StandardCharsets.UTF_8, StandardOpenOption.APPEND)) {
            for (int i = 0; i < shops.size(); i++) {
                JSONObject tbShop = shops.getJSONObject(i);
                String shopName = firstNonBlank(tbShop.getStr("shop_name"), tbShop.getStr("title"), tbShop.getStr("name"));
                ShopMatchState state = states[i];

                MatchResult match = buildMatchResultAfterGlobalAssignment(ctx, state, shopName);

                if ("MATCHED".equals(match.status)) {
                    summary.matchedCount++;
                } else if ("ERROR".equals(match.status)) {
                    // 候选收集阶段已经计过一次错误，这里避免重复计数。
                    if (state == null || !"ERROR".equals(state.status)) {
                        summary.errorCount++;
                    }
                } else {
                    summary.unmatchedCount++;
                }

                writer.write(toCsvLine(ctx, inputFile.getFileName().toString(), i + 1, tbShop, match));
                JSONObject row = toOutputJson(ctx, inputFile.getFileName().toString(), i + 1, tbShop, match);
                appendProgressRow(progressRowsPath, row);
                outputRowCount++;

                if ((i + 1) % 100 == 0 || i + 1 == shops.size()) {
                    System.out.printf("结果输出：%s %d/%d，匹配=%d，未匹配=%d，异常=%d，请求数=%d%n",
                            ctx.outputName, i + 1, shops.size(),
                            summary.matchedCount, summary.unmatchedCount, summary.errorCount,
                            totalApiRequestsThisRun - startApiCount);
                }
            }
        }

        summary.apiRequestCount = totalApiRequestsThisRun - startApiCount;
        summary.finishedAt = now();
        summary.completed = !dailyLimitReached
                && (summary.matchedCount + summary.unmatchedCount + summary.errorCount >= summary.totalShops);

        saveResumeSnapshot(progressPath, buildResumeSnapshot(summary,
                shops.size(), shops.size(), outputRowCount, summary.apiRequestCount));
        writeDistrictJsonFile(jsonPath, inputFile.getFileName().toString(), ctx, summary, progressRowsPath);

        if (summary.completed) {
            deleteIfExists(progressPath);
        }

        System.out.printf("✅ 完成：%s，总数=%d，匹配=%d，未匹配=%d，异常=%d，请求=%d，一对一占用POI=%d%n",
                ctx.outputName, summary.totalShops, summary.matchedCount,
                summary.unmatchedCount, summary.errorCount, summary.apiRequestCount, usedAmapIds.size());

        return summary;
    }

    private static MatchResult buildMatchResultAfterGlobalAssignment(DistrictContext ctx,
                                                                     ShopMatchState state,
                                                                     String shopName) {
        MatchResult result = new MatchResult();
        result.tbShopName = shopName;
        result.matchedAt = now();

        if (state == null) {
            result.status = "ERROR";
            result.reason = "内部错误：ShopMatchState 为空";
            return result;
        }

        result.candidateCount = state.candidateCount;

        if ("ERROR".equals(state.status)) {
            result.status = "ERROR";
            result.score = state.score;
            result.reason = state.reason;
            return result;
        }

        if (!"MATCHED".equals(state.status) || isBlank(state.assignedAmapId)) {
            result.status = "NOT_MATCHED";
            result.score = Math.max(0, state.bestScore);
            result.reason = !isBlank(state.rejectedReason)
                    ? "全局一对一未分配：" + state.rejectedReason
                    : firstNonBlank(state.reason, "无候选或分数低于阈值");
            return result;
        }

        try {
            JSONObject searchJson = searchKeyword(ctx, shopName);
            result.rawKeywordJson = searchJson.toString();

            JSONObject best = findPoiById(searchJson, state.assignedAmapId);
            if (best == null) {
                result.status = "ERROR";
                result.score = state.score;
                result.reason = "已分配 amap_id，但缓存候选中未找到：" + state.assignedAmapId;
                return result;
            }

            if (ENABLE_DETAIL_API) {
                JSONObject detail = fetchDetail(best.getStr("id"));
                if (detail != null) {
                    result.rawDetailJson = detail.toString();
                    JSONObject detailPoi = firstPoi(detail);
                    if (detailPoi != null) {
                        best = mergePoi(best, detailPoi);
                    }
                }
            }

            result.status = "MATCHED";
            result.score = state.score;
            result.reason = state.reason;
            result.amapPoi = best;
            return result;
        } catch (Exception e) {
            result.status = "ERROR";
            result.score = state.score;
            result.reason = e.getClass().getSimpleName() + ": " + safeMsg(e.getMessage());
            return result;
        }
    }

    private static List<CandidateEdge> buildCandidateEdges(DistrictContext ctx,
                                                           String tbName,
                                                           JSONArray candidates,
                                                           int shopIndex,
                                                           ShopMatchState state) {
        List<CandidateEdge> edges = new ArrayList<>();
        if (candidates == null || candidates.isEmpty()) {
            state.reason = "高德无候选";
            return edges;
        }

        boolean districtLevel = !ctx.cityLevel && !isBlank(ctx.districtName) && !"全市".equals(ctx.districtName);

        for (int i = 0; i < candidates.size(); i++) {
            JSONObject poi = candidates.getJSONObject(i);
            CandidateEdge edge = scoreCandidate(ctx, tbName, poi, shopIndex, districtLevel);
            if (edge == null) {
                continue;
            }

            if (edge.score > state.bestScore) {
                state.bestScore = edge.score;
                state.bestReason = edge.reason;
            }

            if (edge.score >= MIN_MATCH_SCORE) {
                edges.add(edge);
            }
        }

        edges.sort((a, b) -> Integer.compare(b.score, a.score));

        if (edges.size() > MAX_CANDIDATES_PER_SHOP_FOR_GLOBAL_MATCH) {
            return new ArrayList<>(edges.subList(0, MAX_CANDIDATES_PER_SHOP_FOR_GLOBAL_MATCH));
        }

        return edges;
    }

    private static CandidateEdge scoreCandidate(DistrictContext ctx,
                                                String tbName,
                                                JSONObject poi,
                                                int shopIndex,
                                                boolean districtLevel) {
        String amapId = poi.getStr("id");
        String amapName = poi.getStr("name");
        String amapAdname = poi.getStr("adname");
        String amapCityname = poi.getStr("cityname");

        if (isBlank(amapId) || isBlank(amapName)) {
            return null;
        }

        if (STRICT_DISTRICT_FILTER && districtLevel && !equalsIgnoreBlank(amapAdname, ctx.districtName)) {
            return null;
        }

        int nameScore = nameSimilarityScore(tbName, amapName);
        int districtBonus = districtLevel && equalsIgnoreBlank(amapAdname, ctx.districtName) ? 18 : 0;
        int cityBonus = equalsIgnoreBlank(amapCityname, ctx.cityName) ? 8 : 0;
        int containsBonus = containsNormalized(tbName, amapName) || containsNormalized(amapName, tbName) ? 8 : 0;
        int penalty = 0;

        if (districtLevel && !isBlank(amapAdname) && !equalsIgnoreBlank(amapAdname, ctx.districtName)) {
            penalty += 10;
        }
        if (!isBlank(amapCityname) && !equalsIgnoreBlank(amapCityname, ctx.cityName)) {
            penalty += 15;
        }

        int score = Math.min(100, nameScore + districtBonus + cityBonus + containsBonus - penalty);
        String reason = String.format("global_one_to_one=true,nameScore=%d,districtLevel=%s,districtBonus=%d,cityBonus=%d,containsBonus=%d,penalty=%d,amapAdname=%s,amapCityname=%s,amapId=%s",
                nameScore, districtLevel, districtBonus, cityBonus, containsBonus, penalty, amapAdname, amapCityname, amapId);

        CandidateEdge edge = new CandidateEdge();
        edge.shopIndex = shopIndex;
        edge.amapId = amapId;
        edge.score = score;
        edge.nameScore = nameScore;
        edge.reason = reason;
        return edge;
    }

    private static JSONObject findPoiById(JSONObject searchJson, String amapId) {
        if (searchJson == null || isBlank(amapId)) {
            return null;
        }

        JSONArray candidates = collectCandidates(searchJson);
        for (int i = 0; i < candidates.size(); i++) {
            JSONObject poi = candidates.getJSONObject(i);
            if (amapId.equals(poi.getStr("id"))) {
                return poi;
            }
        }

        return null;
    }

    private static MatchResult matchOneShop(DistrictContext ctx, JSONObject tbShop, String shopName) {
        MatchResult result = new MatchResult();
        result.tbShopName = shopName;
        result.matchedAt = now();

        try {
            JSONObject searchJson = searchKeyword(ctx, shopName);
            result.rawKeywordJson = searchJson.toString();

            if (!"1".equals(searchJson.getStr("status"))) {
                String info = searchJson.getStr("info");
                String infocode = searchJson.getStr("infocode");
                result.status = "ERROR";
                result.reason = "高德关键词搜索失败：" + info + "/" + infocode;
                handleLimitIfNeeded(info, infocode);
                return result;
            }

            JSONArray candidates = collectCandidates(searchJson);
            result.candidateCount = candidates.size();

            JSONObject best = chooseBestCandidate(ctx, shopName, candidates, result);
            if (best == null) {
                result.status = "NOT_MATCHED";
                result.reason = result.reason == null ? "无候选或分数低于阈值" : result.reason;
                return result;
            }

            if (ENABLE_DETAIL_API) {
                JSONObject detail = fetchDetail(best.getStr("id"));
                if (detail != null) {
                    result.rawDetailJson = detail.toString();
                    JSONObject detailPoi = firstPoi(detail);
                    if (detailPoi != null) {
                        best = mergePoi(best, detailPoi);
                    }
                }
            }

            result.status = "MATCHED";
            result.amapPoi = best;
            return result;
        } catch (Exception e) {
            result.status = "ERROR";
            result.reason = e.getClass().getSimpleName() + ": " + safeMsg(e.getMessage());
            return result;
        }
    }

    private static JSONObject searchKeyword(DistrictContext ctx, String shopName) throws IOException, InterruptedException {
        String cacheKey = "text_" + md5Like(ctx.region + "__" + shopName) + ".json";
        JSONObject cached = readCache(cacheKey);
        if (cached != null) {
            return cached;
        }

        JSONArray mergedPois = new JSONArray();
        JSONObject firstJson = null;
        String lastStatus = "1";
        String lastInfo = "OK";
        String lastInfocode = "10000";
        String count = "0";

        for (int page = 1; page <= MAX_SEARCH_PAGES; page++) {
            String url = TEXT_SEARCH_URL
                    + "?key=" + urlEncode(API_KEY)
                    + "&keywords=" + urlEncode(shopName)
                    // 按用户要求：不设置 types，避免因类型限制搜索不到
                    + "&region=" + urlEncode(ctx.region)
                    + "&city_limit=true"
                    + "&show_fields=" + urlEncode(SHOW_FIELDS)
                    + "&page_size=" + PAGE_SIZE
                    + "&page_num=" + page
                    + "&output=json";

            JSONObject pageJson = requestJson(url);
            if (firstJson == null) {
                firstJson = pageJson;
            }

            lastStatus = pageJson.getStr("status");
            lastInfo = pageJson.getStr("info");
            lastInfocode = pageJson.getStr("infocode");
            count = pageJson.getStr("count", count);

            if (!"1".equals(lastStatus)) {
                handleLimitIfNeeded(lastInfo, lastInfocode);
                break;
            }

            JSONArray pois = pageJson.getJSONArray("pois");
            if (pois == null || pois.isEmpty()) {
                break;
            }
            for (int i = 0; i < pois.size(); i++) {
                mergedPois.add(pois.getJSONObject(i));
            }
            if (pois.size() < PAGE_SIZE) {
                break;
            }
        }

        JSONObject merged = new JSONObject(true);
        merged.set("status", lastStatus);
        merged.set("info", lastInfo);
        merged.set("infocode", lastInfocode);
        merged.set("count", count);
        merged.set("pois", mergedPois);
        merged.set("query_keywords", shopName);
        merged.set("query_region", ctx.region);
        merged.set("query_page_size", PAGE_SIZE);
        merged.set("query_max_pages", MAX_SEARCH_PAGES);

        writeCache(cacheKey, merged);
        return merged;
    }

    private static JSONObject fetchDetail(String poiId) throws IOException, InterruptedException {
        if (isBlank(poiId)) {
            return null;
        }
        String cacheKey = "detail_" + safeFileName(poiId) + ".json";
        JSONObject cached = readCache(cacheKey);
        if (cached != null) {
            return cached;
        }

        String url = DETAIL_URL
                + "?key=" + urlEncode(API_KEY)
                + "&id=" + urlEncode(poiId)
                + "&show_fields=" + urlEncode(SHOW_FIELDS)
                + "&output=json";

        JSONObject json = requestJson(url);
        if (!"1".equals(json.getStr("status"))) {
            handleLimitIfNeeded(json.getStr("info"), json.getStr("infocode"));
            return json;
        }
        writeCache(cacheKey, json);
        return json;
    }

    private static JSONObject chooseBestCandidate(DistrictContext ctx, String tbName, JSONArray candidates, MatchResult result) {
        if (candidates == null || candidates.isEmpty()) {
            result.reason = "高德无候选";
            return null;
        }

        // 城市级文件（如“徐州市.json”）没有具体区县，不能使用区县强过滤；
        // 区县级文件（如“徐州市-铜山区.json”）才使用 districtName/adname 约束。
        boolean districtLevel = !ctx.cityLevel && !isBlank(ctx.districtName) && !"全市".equals(ctx.districtName);

        int bestScore = -1;
        JSONObject best = null;
        String bestReason = "";

        for (int i = 0; i < candidates.size(); i++) {
            JSONObject poi = candidates.getJSONObject(i);
            String amapName = poi.getStr("name");
            String amapAdname = poi.getStr("adname");
            String amapCityname = poi.getStr("cityname");

            int nameScore = nameSimilarityScore(tbName, amapName);
            int districtBonus = districtLevel && equalsIgnoreBlank(amapAdname, ctx.districtName) ? 18 : 0;
            int cityBonus = equalsIgnoreBlank(amapCityname, ctx.cityName) ? 8 : 0;
            int containsBonus = containsNormalized(tbName, amapName) || containsNormalized(amapName, tbName) ? 8 : 0;
            int penalty = 0;

            if (STRICT_DISTRICT_FILTER && districtLevel && !equalsIgnoreBlank(amapAdname, ctx.districtName)) {
                continue;
            }
            if (districtLevel && !isBlank(amapAdname) && !equalsIgnoreBlank(amapAdname, ctx.districtName)) {
                penalty += 10;
            }
            if (!isBlank(amapCityname) && !equalsIgnoreBlank(amapCityname, ctx.cityName)) {
                penalty += 15;
            }

            int score = Math.min(100, nameScore + districtBonus + cityBonus + containsBonus - penalty);
            String reason = String.format("nameScore=%d,districtLevel=%s,districtBonus=%d,cityBonus=%d,containsBonus=%d,penalty=%d,amapAdname=%s,amapCityname=%s",
                    nameScore, districtLevel, districtBonus, cityBonus, containsBonus, penalty, amapAdname, amapCityname);

            if (score > bestScore) {
                bestScore = score;
                best = poi;
                bestReason = reason;
            }
        }

        result.score = bestScore;
        result.reason = bestReason;
        if (best == null || bestScore < MIN_MATCH_SCORE) {
            result.reason = "低于阈值：score=" + bestScore + "; " + bestReason;
            return null;
        }
        return best;
    }

    private static int nameSimilarityScore(String a, String b) {
        String na = normalizeName(a);
        String nb = normalizeName(b);
        if (isBlank(na) || isBlank(nb)) {
            return 0;
        }
        if (na.equals(nb)) {
            return 100;
        }
        if (na.contains(nb) || nb.contains(na)) {
            int shorter = Math.min(na.length(), nb.length());
            int longer = Math.max(na.length(), nb.length());
            return Math.max(75, (int) Math.round(shorter * 100.0 / longer));
        }
        int lcs = lcsLength(na, nb);
        return (int) Math.round(lcs * 200.0 / (na.length() + nb.length()));
    }

    private static boolean containsNormalized(String a, String b) {
        String na = normalizeName(a);
        String nb = normalizeName(b);
        return !isBlank(na) && !isBlank(nb) && na.contains(nb);
    }

    private static String normalizeName(String s) {
        if (s == null) {
            return "";
        }
        return s.toLowerCase(Locale.ROOT)
                .replaceAll("[\\s\\-—_·•・,，.。:：;；/\\\\|()（）\\[\\]【】{}《》<>+＋&＆'\"“”‘’!！?？]", "")
                .replace("餐饮", "")
                .replace("外卖", "");
    }

    private static int lcsLength(String a, String b) {
        int m = a.length(), n = b.length();
        int[] dp = new int[n + 1];
        for (int i = 1; i <= m; i++) {
            int prev = 0;
            for (int j = 1; j <= n; j++) {
                int temp = dp[j];
                if (a.charAt(i - 1) == b.charAt(j - 1)) {
                    dp[j] = prev + 1;
                } else {
                    dp[j] = Math.max(dp[j], dp[j - 1]);
                }
                prev = temp;
            }
        }
        return dp[n];
    }

    private static JSONArray collectCandidates(JSONObject searchJson) {
        JSONArray pois = searchJson.getJSONArray("pois");
        return pois == null ? new JSONArray() : pois;
    }

    private static JSONObject firstPoi(JSONObject json) {
        JSONArray pois = json.getJSONArray("pois");
        if (pois == null || pois.isEmpty()) {
            return null;
        }
        return pois.getJSONObject(0);
    }

    private static String toCsvLine(DistrictContext ctx, String sourceFile, int index, JSONObject tb, MatchResult m) {
        JSONObject poi = m.amapPoi == null ? new JSONObject() : m.amapPoi;
        JSONObject business = getBusiness(poi);
        return String.join(",",
                csv(sourceFile), csv(ctx.cityName), csv(ctx.districtName), csv(ctx.region),
                csv(String.valueOf(index)), csv(m.tbShopName), csv(tb.getStr("shop_id")), csv(tb.getStr("origin_store_id")),
                csv(tb.getStr("en_ele_shop_id")), csv(tb.getStr("md5_shop_id")), csv(tb.getStr("rate")),
                csv(tb.getStr("monthly_sale_text")), csv(tb.getStr("monthly_sale_number")), csv(tb.getStr("delivery_price")),
                csv(tb.getStr("delivery_price_yuan")), csv(tb.getStr("commission_rate")), csv(tb.getStr("commission")),
                csv(tb.getStr("tag_list")), csv(tb.getStr("recommend_reasons")),
                csv(m.status), csv(String.valueOf(m.score)), csv(m.reason), csv(String.valueOf(m.candidateCount)),
                csv(poi.getStr("id")), csv(poi.getStr("name")), csv(poi.getStr("type")), csv(poi.getStr("typecode")),
                csv(poi.getStr("pname")), csv(poi.getStr("cityname")), csv(poi.getStr("adname")),
                csv(poi.getStr("pcode")), csv(poi.getStr("adcode")), csv(poi.getStr("citycode")),
                csv(poi.getStr("address")), csv(poi.getStr("location")),
                csv(firstNonBlank(poi.getStr("tel"), business.getStr("tel"))),
                csv(firstNonBlank(poi.getStr("business_area"), business.getStr("business_area"))),
                csv(firstNonBlank(poi.getStr("rating"), business.getStr("rating"))),
                csv(firstNonBlank(poi.getStr("cost"), business.getStr("cost"))),
                csv(business.getStr("opentime_today")), csv(business.getStr("opentime_week")),
                csv(m.rawKeywordJson), csv(m.rawDetailJson), csv(m.matchedAt)
        ) + "\n";
    }

    private static JSONObject toOutputJson(DistrictContext ctx, String sourceFile, int index, JSONObject tb, MatchResult m) {
        JSONObject row = new JSONObject(true);
        row.set("source_file", sourceFile);
        row.set("source_city_name", ctx.cityName);
        row.set("source_district_name", ctx.districtName);
        row.set("source_region", ctx.region);
        row.set("index", index);
        row.set("taobao_shop", tb);
        row.set("match_status", m.status);
        row.set("match_score", m.score);
        row.set("match_reason", m.reason);
        row.set("candidate_count", m.candidateCount);
        row.set("amap_poi", m.amapPoi == null ? new JSONObject(true) : m.amapPoi);
        row.set("raw_keyword_json", parseRawJsonOrString(m.rawKeywordJson));
        row.set("raw_detail_json", parseRawJsonOrString(m.rawDetailJson));
        row.set("matched_at", m.matchedAt);
        return row;
    }

    private static Object parseRawJsonOrString(String s) {
        if (isBlank(s)) {
            return new JSONObject(true);
        }
        try {
            return JSONUtil.parseObj(s);
        } catch (Exception e) {
            return s;
        }
    }

    private static JSONObject getBusiness(JSONObject poi) {
        if (poi == null) {
            return new JSONObject();
        }
        JSONObject business = poi.getJSONObject("business");
        return business == null ? new JSONObject() : business;
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

    private static JSONObject requestJson(String url) throws IOException, InterruptedException {
        Exception last = null;

        for (int attempt = 1; attempt <= MAX_RETRY; attempt++) {
            try {
                checkBudget();

                HttpRequest request = HttpRequest.newBuilder()
                        .uri(URI.create(url))
                        .GET()
                        .build();

                HttpResponse<String> response = CLIENT.send(request, HttpResponse.BodyHandlers.ofString());
                totalApiRequestsThisRun++;
                sleepQuietly(REQUEST_INTERVAL_MS);

                String body = response.body();
                if (response.statusCode() >= 200 && response.statusCode() < 300 && !isBlank(body)) {
                    return JSONUtil.parseObj(body);
                }
                last = new IOException("HTTP " + response.statusCode() + ": " + body);
            } catch (Exception e) {
                last = e;
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

    private static void checkBudget() throws IOException {
        if (MAX_API_REQUESTS_PER_RUN > 0 && totalApiRequestsThisRun >= MAX_API_REQUESTS_PER_RUN) {
            throw new IOException("已达到本次运行请求预算上限：" + MAX_API_REQUESTS_PER_RUN);
        }
    }

    private static void handleLimitIfNeeded(String info, String infocode) {
        if ("10044".equals(infocode) || "USER_DAILY_QUERY_OVER_LIMIT".equals(info)) {
            dailyLimitReached = true;
            throw new RuntimeException("高德账号日调用量已超限，停止采集，避免生成不完整数据。");
        }
        if ("10021".equals(infocode) || "CUQPS_HAS_EXCEEDED_THE_LIMIT".equals(info)) {
            sleepQuietly(REQUEST_INTERVAL_MS * 3L);
        }
    }

    private static JSONObject readJson(Path path) throws IOException {
        Charset charset = detectCharset(path);
        String text = Files.readString(path, charset);
        text = stripBom(text).trim();

        if (isBlank(text)) {
            throw new IOException("输入 JSON 文件为空：" + path.getFileName());
        }

        // 支持两种根结构：
        // 1. { "shops": [...] } / { "rows": [...] }
        // 2. [ {...}, {...} ]  —— 城市级文件或导出文件直接是数组时，自动包装为 shops
        if (text.startsWith("{")) {
            return JSONUtil.parseObj(text);
        }
        if (text.startsWith("[")) {
            JSONObject wrapper = new JSONObject(true);
            wrapper.set("shops", JSONUtil.parseArray(text));
            wrapper.set("_wrapped_array_root", true);
            return wrapper;
        }

        String preview = text.length() > 80 ? text.substring(0, 80) + "..." : text;
        throw new IOException("输入文件不是合法 JSON 对象或数组：" + path.getFileName() + "，开头内容=" + preview);
    }

    private static JSONArray getShopArray(JSONObject inputJson) {
        // 常见结构：{ "shops": [...] }
        JSONArray shops = inputJson.getJSONArray("shops");
        if (shops != null && !shops.isEmpty()) {
            return shops;
        }

        // 浏览器采集助手导出的表格行：{ "rows": [...] }
        JSONArray rows = inputJson.getJSONArray("rows");
        if (rows != null && !rows.isEmpty()) {
            return rows;
        }

        // 兼容其他可能的城市级导出结构
        JSONArray data = inputJson.getJSONArray("data");
        if (data != null && !data.isEmpty()) {
            return data;
        }

        JSONArray list = inputJson.getJSONArray("list");
        if (list != null && !list.isEmpty()) {
            return list;
        }

        return new JSONArray();
    }

    private static List<Path> listJsonFiles(Path inputDir) throws IOException {
        List<Path> files = new ArrayList<>();
        try (java.util.stream.Stream<Path> stream = Files.list(inputDir)) {
            stream.filter(p -> p.toString().toLowerCase(Locale.ROOT).endsWith(".json"))
                    .sorted(Comparator.comparing(p -> p.getFileName().toString()))
                    .forEach(files::add);
        }
        return files;
    }

    private static DistrictContext parseDistrictContext(Path file) {
        String name = file.getFileName().toString();
        if (name.toLowerCase(Locale.ROOT).endsWith(".json")) {
            name = name.substring(0, name.length() - 5);
        }
        name = name.replace("（", "(").replace("）", ")").trim();
        int dash = name.indexOf('-');
        if (dash < 0) {
            dash = name.indexOf('_');
        }

        DistrictContext ctx = new DistrictContext();
        ctx.sourceBaseName = name;

        // 支持两种文件名：
        // 1. 徐州市-铜山区.json => 区县级，region=徐州市铜山区
        // 2. 徐州市.json => 城市级，region=徐州市，不做区县强过滤
        if (dash > 0) {
            ctx.cityName = name.substring(0, dash).trim();
            ctx.districtName = name.substring(dash + 1).trim();
            ctx.cityLevel = false;
            ctx.outputName = ctx.cityName + "-" + ctx.districtName;
        } else {
            ctx.cityName = name.trim();
            ctx.districtName = "全市";
            ctx.cityLevel = true;
            ctx.outputName = ctx.cityName;
        }

        ctx.region = ctx.cityLevel ? ctx.cityName : ctx.cityName + ctx.districtName;
        return ctx;
    }

    private static JSONObject readCache(String fileName) {
        if (!ENABLE_CACHE) {
            return null;
        }
        try {
            Path path = Paths.get(CACHE_DIR).resolve(fileName);
            if (!Files.exists(path) || Files.size(path) == 0) {
                return null;
            }
            return JSONUtil.parseObj(Files.readString(path, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null;
        }
    }

    private static void writeCache(String fileName, JSONObject json) {
        if (!ENABLE_CACHE || json == null) {
            return;
        }
        try {
            Path dir = Paths.get(CACHE_DIR);
            Files.createDirectories(dir);
            Files.writeString(dir.resolve(fileName), json.toString(), StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
        } catch (Exception ignore) {
        }
    }

    private static void appendSummary(Path summaryPath, DistrictSummary s) throws IOException {
        try (BufferedWriter writer = Files.newBufferedWriter(summaryPath, StandardCharsets.UTF_8, StandardOpenOption.APPEND)) {
            writer.write(String.join(",",
                    csv(s.sourceFile), csv(s.cityName), csv(s.districtName), csv(String.valueOf(s.totalShops)),
                    csv(String.valueOf(s.matchedCount)), csv(String.valueOf(s.unmatchedCount)),
                    csv(String.valueOf(s.errorCount)), csv(String.valueOf(s.apiRequestCount)),
                    csv(s.outputCsv), csv(s.outputJson), csv(s.finishedAt)
            ) + "\n");
        }
    }

    private static void mergeDistrictFiles(Path byDistrictRoot, Path allPath) throws IOException {
        initCsvWithHeader(allPath, CSV_HEADER);
        try (BufferedWriter allWriter = Files.newBufferedWriter(allPath, StandardCharsets.UTF_8, StandardOpenOption.APPEND)) {
            if (!Files.exists(byDistrictRoot)) {
                return;
            }

            List<Path> csvFiles = new ArrayList<>();
            try (java.util.stream.Stream<Path> stream = Files.walk(byDistrictRoot)) {
                stream.filter(path -> path.toString().endsWith("_amap_keyword.csv"))
                        .sorted(Comparator.comparing(path -> path.toString()))
                        .forEach(csvFiles::add);
            }

            for (Path path : csvFiles) {
                try {
                    Charset charset = detectCharset(path);
                    List<String> lines = Files.readAllLines(path, charset);
                    for (int i = 1; i < lines.size(); i++) {
                        allWriter.write(stripBom(lines.get(i)));
                        allWriter.write("\n");
                    }
                } catch (Exception e) {
                    // 不让一个历史损坏/编码异常的 CSV 影响本次全部任务
                    System.err.println("合并 CSV 跳过文件：" + path + "，原因：" + safeMsg(e.getMessage()));
                }
            }
        }
    }

    private static void mergeDistrictJsonFiles(Path byDistrictRoot, Path allPath) throws IOException {
        Files.createDirectories(allPath.getParent());

        Path progressDir = Paths.get(PROGRESS_DIR);
        List<Path> rowFiles = new ArrayList<>();
        if (Files.exists(progressDir)) {
            try (java.util.stream.Stream<Path> stream = Files.list(progressDir)) {
                stream.filter(path -> path.toString().endsWith(".rows.jsonl"))
                        .sorted(Comparator.comparing(path -> path.toString()))
                        .forEach(rowFiles::add);
            }
        }

        int rowCount = 0;
        try (BufferedWriter writer = Files.newBufferedWriter(allPath, StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING)) {
            writer.write("{\n");
            writer.write("  \"exported_at\": \"" + jsonEscape(now()) + "\",\n");
            writer.write("  \"source_root\": \"" + jsonEscape(byDistrictRoot.toAbsolutePath().toString()) + "\",\n");
            writer.write("  \"rows\": [\n");

            boolean first = true;
            for (Path rowFile : rowFiles) {
                Charset charset;
                try {
                    charset = detectCharset(rowFile);
                } catch (Exception e) {
                    charset = StandardCharsets.UTF_8;
                }
                try (java.io.BufferedReader reader = Files.newBufferedReader(rowFile, charset)) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        String trimmed = stripBom(line).trim();
                        if (trimmed.isEmpty()) {
                            continue;
                        }
                        // 简单校验，避免写入坏行。
                        if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
                            continue;
                        }
                        if (!first) {
                            writer.write(",\n");
                        }
                        writer.write("    ");
                        writer.write(trimmed);
                        first = false;
                        rowCount++;
                    }
                } catch (Exception e) {
                    System.err.println("合并 JSONL 跳过文件：" + rowFile + "，原因：" + safeMsg(e.getMessage()));
                }
            }

            writer.write("\n  ],\n");
            writer.write("  \"row_count\": " + rowCount + ",\n");
            writer.write("  \"row_file_count\": " + rowFiles.size() + "\n");
            writer.write("}\n");
        }
    }

    private static void writeDistrictJsonFile(Path jsonPath, String sourceFile, DistrictContext ctx,
                                              DistrictSummary summary, Path progressRowsPath) throws IOException {
        Files.createDirectories(jsonPath.getParent());
        int rowCount = 0;

        try (BufferedWriter writer = Files.newBufferedWriter(jsonPath, StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING)) {
            writer.write("{\n");
            writer.write("  \"source_file\": \"" + jsonEscape(sourceFile) + "\",\n");
            writer.write("  \"city_name\": \"" + jsonEscape(ctx.cityName) + "\",\n");
            writer.write("  \"district_name\": \"" + jsonEscape(ctx.districtName) + "\",\n");
            writer.write("  \"region\": \"" + jsonEscape(ctx.region) + "\",\n");
            writer.write("  \"total_shops\": " + summary.totalShops + ",\n");
            writer.write("  \"matched_count\": " + summary.matchedCount + ",\n");
            writer.write("  \"unmatched_count\": " + summary.unmatchedCount + ",\n");
            writer.write("  \"error_count\": " + summary.errorCount + ",\n");
            writer.write("  \"api_request_count\": " + summary.apiRequestCount + ",\n");
            writer.write("  \"completed\": " + summary.completed + ",\n");
            writer.write("  \"exported_at\": \"" + jsonEscape(now()) + "\",\n");
            writer.write("  \"rows\": [\n");

            boolean first = true;
            if (Files.exists(progressRowsPath)) {
                Charset charset;
                try {
                    charset = detectCharset(progressRowsPath);
                } catch (Exception e) {
                    charset = StandardCharsets.UTF_8;
                }
                try (java.io.BufferedReader reader = Files.newBufferedReader(progressRowsPath, charset)) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        String trimmed = stripBom(line).trim();
                        if (trimmed.isEmpty() || !trimmed.startsWith("{") || !trimmed.endsWith("}")) {
                            continue;
                        }
                        if (!first) {
                            writer.write(",\n");
                        }
                        writer.write("    ");
                        writer.write(trimmed);
                        first = false;
                        rowCount++;
                    }
                }
            }

            writer.write("\n  ],\n");
            writer.write("  \"row_count\": " + rowCount + "\n");
            writer.write("}\n");
        }
    }

    private static String jsonEscape(String value) {
        if (value == null) {
            return "";
        }
        return value.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\r", "\\r")
                .replace("\n", "\\n")
                .replace("\t", "\\t");
    }

    private static void writeSummaryJson(Path summaryJsonPath, List<DistrictSummary> summaries) throws IOException {
        JSONObject root = new JSONObject(true);
        JSONArray rows = new JSONArray();

        for (DistrictSummary s : summaries) {
            JSONObject item = new JSONObject(true);
            item.set("source_file", s.sourceFile);
            item.set("city_name", s.cityName);
            item.set("district_name", s.districtName);
            item.set("total_shops", s.totalShops);
            item.set("matched_count", s.matchedCount);
            item.set("unmatched_count", s.unmatchedCount);
            item.set("error_count", s.errorCount);
            item.set("api_request_count", s.apiRequestCount);
            item.set("output_csv", s.outputCsv);
            item.set("output_json", s.outputJson);
            item.set("finished_at", s.finishedAt);
            rows.add(item);
        }

        root.set("exported_at", now());
        root.set("total_files", summaries.size());
        root.set("rows", rows);

        Files.createDirectories(summaryJsonPath.getParent());
        Files.writeString(summaryJsonPath, JSONUtil.toJsonPrettyStr(root), StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
    }

    private static void initCsvWithHeader(Path path, String header) throws IOException {
        Files.createDirectories(path.getParent());
        try (BufferedWriter writer = Files.newBufferedWriter(path, StandardCharsets.UTF_8)) {
            writer.write('\ufeff');
            writer.write(header);
        }
    }

    private static ResumeSnapshot loadResumeSnapshot(Path progressPath, Path progressRowsPath, Path csvPath, int totalShops) {
        ResumeSnapshot snapshot = new ResumeSnapshot();

        JSONObject progress = readJsonIfExists(progressPath);
        if (progress != null) {
            snapshot.nextIndex = Math.min(progress.getInt("next_index", 0), totalShops);
            snapshot.matchedCount = progress.getInt("matched_count", 0);
            snapshot.unmatchedCount = progress.getInt("unmatched_count", 0);
            snapshot.errorCount = progress.getInt("error_count", 0);
            snapshot.apiRequestCount = progress.getInt("api_request_count", 0);
            snapshot.outputRowCount = progress.getInt("output_row_count", 0);
            return snapshot;
        }

        if (Files.exists(csvPath)) {
            CsvResumeStats stats = scanExistingCsv(csvPath);
            snapshot.nextIndex = Math.min(stats.processedRows, totalShops);
            snapshot.matchedCount = stats.matchedCount;
            snapshot.unmatchedCount = stats.unmatchedCount;
            snapshot.errorCount = stats.errorCount;
            snapshot.outputRowCount = stats.processedRows;
        }

        return snapshot;
    }

    private static ResumeSnapshot buildResumeSnapshot(DistrictSummary summary, int nextIndex, int totalShops,
                                                      int outputRowCount, int apiRequestCount) {
        ResumeSnapshot snapshot = new ResumeSnapshot();
        snapshot.nextIndex = Math.min(nextIndex, totalShops);
        snapshot.matchedCount = summary.matchedCount;
        snapshot.unmatchedCount = summary.unmatchedCount;
        snapshot.errorCount = summary.errorCount;
        snapshot.outputRowCount = outputRowCount;
        snapshot.apiRequestCount = apiRequestCount;
        return snapshot;
    }

    private static void saveResumeSnapshot(Path progressPath, ResumeSnapshot snapshot) {
        if (!ENABLE_RESUME || snapshot == null) {
            return;
        }
        JSONObject json = new JSONObject(true);
        json.set("next_index", snapshot.nextIndex);
        json.set("matched_count", snapshot.matchedCount);
        json.set("unmatched_count", snapshot.unmatchedCount);
        json.set("error_count", snapshot.errorCount);
        json.set("output_row_count", snapshot.outputRowCount);
        json.set("api_request_count", snapshot.apiRequestCount);
        json.set("saved_at", now());
        try {
            Files.createDirectories(progressPath.getParent());
            Files.writeString(progressPath, JSONUtil.toJsonPrettyStr(json), StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
        } catch (IOException ignore) {
        }
    }

    private static JSONArray loadProgressRows(Path progressRowsPath) {
        JSONArray rows = new JSONArray();
        if (!ENABLE_RESUME || !Files.exists(progressRowsPath)) {
            return rows;
        }
        try {
            for (String line : Files.readAllLines(progressRowsPath, StandardCharsets.UTF_8)) {
                String trimmed = stripBom(line).trim();
                if (!trimmed.isEmpty()) {
                    rows.add(JSONUtil.parseObj(trimmed));
                }
            }
        } catch (Exception ignore) {
        }
        return rows;
    }

    private static void appendProgressRow(Path progressRowsPath, JSONObject row) {
        if (!ENABLE_RESUME || row == null) {
            return;
        }
        try (BufferedWriter writer = Files.newBufferedWriter(progressRowsPath, StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.APPEND)) {
            writer.write(row.toString());
            writer.write("\n");
        } catch (IOException ignore) {
        }
    }

    private static JSONObject readJsonIfExists(Path path) {
        if (path == null || !Files.exists(path)) {
            return null;
        }
        try {
            return JSONUtil.parseObj(stripBom(Files.readString(path, StandardCharsets.UTF_8)).trim());
        } catch (Exception e) {
            return null;
        }
    }

    private static CsvResumeStats scanExistingCsv(Path csvPath) {
        CsvResumeStats stats = new CsvResumeStats();
        try {
            Charset charset = detectCharset(csvPath);
            List<String> lines = Files.readAllLines(csvPath, charset);
            for (int i = 1; i < lines.size(); i++) {
                String line = stripBom(lines.get(i)).trim();
                if (line.isEmpty()) {
                    continue;
                }
                List<String> columns = parseCsvLine(line);
                if (columns.size() <= CSV_MATCH_STATUS_INDEX) {
                    continue;
                }
                stats.processedRows++;
                String status = columns.get(CSV_MATCH_STATUS_INDEX);
                if ("MATCHED".equals(status)) {
                    stats.matchedCount++;
                } else if ("ERROR".equals(status)) {
                    stats.errorCount++;
                } else {
                    stats.unmatchedCount++;
                }
            }
        } catch (Exception ignore) {
        }
        return stats;
    }

    private static List<String> parseCsvLine(String line) {
        List<String> columns = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        boolean inQuotes = false;

        for (int i = 0; i < line.length(); i++) {
            char ch = line.charAt(i);
            if (ch == '"') {
                if (inQuotes && i + 1 < line.length() && line.charAt(i + 1) == '"') {
                    current.append('"');
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (ch == ',' && !inQuotes) {
                columns.add(current.toString());
                current.setLength(0);
            } else {
                current.append(ch);
            }
        }
        columns.add(current.toString());
        return columns;
    }

    private static void deleteIfExists(Path path) {
        if (path == null) {
            return;
        }
        try {
            Files.deleteIfExists(path);
        } catch (IOException ignore) {
        }
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

    private static String stripBom(String text) {
        if (text == null) {
            return "";
        }
        if (!text.isEmpty() && text.charAt(0) == '\ufeff') {
            return text.substring(1);
        }
        return text;
    }

    private static String firstNonBlank(String... values) {
        if (values == null) {
            return "";
        }
        for (String v : values) {
            if (!isBlank(v)) {
                return v;
            }
        }
        return "";
    }

    private static boolean equalsIgnoreBlank(String a, String b) {
        return !isBlank(a) && !isBlank(b) && a.trim().equals(b.trim());
    }

    private static String csv(String value) {
        if (value == null) {
            value = "";
        }
        value = value.replace("\r", " ").replace("\n", " ");
        return "\"" + value.replace("\"", "\"\"") + "\"";
    }

    private static String urlEncode(String value) {
        try {
            return URLEncoder.encode(value == null ? "" : value, StandardCharsets.UTF_8.name());
        } catch (Exception e) {
            return value;
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

    private static String md5Like(String s) {
        // 不额外引入 MessageDigest 异常处理复杂度，缓存名只需稳定即可。
        return Integer.toHexString(Objects.toString(s, "").hashCode()) + "_" + Math.abs(Objects.toString(s, "").length());
    }

    private static class DistrictContext {
        String sourceBaseName;
        String cityName;
        String districtName;
        String region;
        String outputName;
        boolean cityLevel;
    }

    private static class ShopMatchState {
        int index = -1;
        String shopName = "";
        String status = "NOT_MATCHED";
        int candidateCount = 0;
        int bestScore = -1;
        String bestReason = "";
        String rejectedReason = "";
        String assignedAmapId = "";
        int score = 0;
        String reason = "";
    }

    private static class CandidateEdge {
        int shopIndex;
        String amapId;
        int score;
        int nameScore;
        String reason;
    }

    private static class MatchResult {
        String tbShopName = "";
        String status = "NOT_MATCHED";
        int score = 0;
        String reason = "";
        int candidateCount = 0;
        JSONObject amapPoi;
        String rawKeywordJson = "";
        String rawDetailJson = "";
        String matchedAt = now();
    }

    private static class DistrictSummary {
        String sourceFile = "";
        String cityName = "";
        String districtName = "";
        int totalShops = 0;
        int matchedCount = 0;
        int unmatchedCount = 0;
        int errorCount = 0;
        int apiRequestCount = 0;
        String outputCsv = "";
        String outputJson = "";
        boolean completed = false;
        String finishedAt = now();
    }

    private static class ResumeSnapshot {
        int nextIndex = 0;
        int matchedCount = 0;
        int unmatchedCount = 0;
        int errorCount = 0;
        int outputRowCount = 0;
        int apiRequestCount = 0;
        // 不再在内存中保存全部输出 rows；大文件行数据保存在 .rows.jsonl 中。
    }

    private static class CsvResumeStats {
        int processedRows = 0;
        int matchedCount = 0;
        int unmatchedCount = 0;
        int errorCount = 0;
    }
}


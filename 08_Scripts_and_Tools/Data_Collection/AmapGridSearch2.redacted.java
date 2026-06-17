package cn.laizhiyuantech;

import cn.hutool.json.JSONArray;
import cn.hutool.json.JSONObject;
import cn.hutool.json.JSONUtil;

import java.io.FileWriter;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

public class AmapGridSearch2 {

    // 配置信息
    private static final String API_KEY = System.getenv("AMAP_API_KEY");
    private static final double RADIUS = 4000; // 搜索半径（米）
    private static final double STEP_METERS = RADIUS * 1.414; // 为了无缝覆盖，步长设为半径的 1.414 倍 (R * sqrt(2))

    // 徐州市大致矩形范围 (西南角 & 东北角) - 依然用作外层循环的粗筛边界
    private static final double MIN_LON = 116.35, MAX_LON = 118.66;
    private static final double MIN_LAT = 33.72, MAX_LAT = 34.97;

    private static final HttpClient client = HttpClient.newHttpClient();
    private static final Set<String> poiIds = new HashSet<>();

    private static String csvFile = "poi_list.csv";

    // 用于存储徐州市的多个多边形边界（有些城市可能有飞地，所以是List的List）
    private static List<List<double[]>> cityPolygons = new ArrayList<>();

    public static void main(String[] args) throws IOException, InterruptedException {
        // 1. 初始化并获取徐州市的精确行政边界
        System.out.println("正在获取徐州市精确行政边界...");
        initCityBoundary("320300");
        if (cityPolygons.isEmpty()) {
            System.err.println("未能获取到城市边界，程序终止。");
            return;
        }
        System.out.println("边界获取成功，开始执行网格扫描...");

        double currentLat = MIN_LAT;
        FileWriter writer = new FileWriter(csvFile);
        writer.write(
                "id,name,type,typecode,pname,cityname,adname,pcode,adcode,citycode,address,location,distance,parent\n");

        int skipCount = 0;
        int fetchCount = 0;

        // 纵向循环：从南向北移动
        while (currentLat <= MAX_LAT) {
            double currentLon = MIN_LON;
            // 计算当前纬度下，移动 STEP_METERS 对应的经度度数偏移
            double lonStepDegree = metersToLongitudeDegree(STEP_METERS, currentLat);

            // 横向循环：从西向东移动
            while (currentLon <= MAX_LON) {
                // 2. 核心改动：判断当前点是否在徐州市的多边形轮廓内
                if (isPointInPolygons(currentLon, currentLat, cityPolygons)) {
                    System.out.printf("🎯 点 [%.6f, %.6f] 在徐州市内，执行搜索...\n", currentLon, currentLat);
                    fetchPoisAround(currentLon, currentLat, writer);
                    fetchCount++;
                } else {
                    // 不在范围内，直接跳过，节省接口额度
                    skipCount++;
                }

                // 经度增加
                currentLon += lonStepDegree;
            }

            // 纬度增加：移动 STEP_METERS 对应的纬度度数偏移
            currentLat += metersToLatitudeDegree(STEP_METERS);
        }

        writer.close();
        System.out.println("=========================================");
        System.out.println("全部扫描完成！");
        System.out.println("成功请求的有效网格数：" + fetchCount);
        System.out.println("算法拦截的无效网格数：" + skipCount + " (帮你省下的API调用量)");
        System.out.println("去重后商家总数：" + poiIds.size());
    }

    /**
     * 通过高德行政区划接口获取城市边界轮廓
     */
    private static void initCityBoundary(String cityName) throws IOException, InterruptedException {
        String encodedCityName = URLEncoder.encode(cityName, StandardCharsets.UTF_8.name());

        String url = String.format(
                "https://restapi.amap.com/v3/config/district?keywords=%s&subdistrict=0&extensions=all&key=%s",
                encodedCityName,
                API_KEY
        );

        System.out.println("行政区划请求URL: " + url);

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .GET()
                .build();

        String response = client.send(request, HttpResponse.BodyHandlers.ofString()).body();

        System.out.println("行政区划接口返回: " + response);

        JSONObject jsonObject = JSONUtil.parseObj(response);

        String status = jsonObject.getStr("status");
        String info = jsonObject.getStr("info");
        String infocode = jsonObject.getStr("infocode");

        if (!"1".equals(status)) {
            System.err.println("行政区划接口调用失败！");
            System.err.println("status = " + status);
            System.err.println("info = " + info);
            System.err.println("infocode = " + infocode);
            return;
        }

        JSONArray districts = jsonObject.getJSONArray("districts");
        if (districts == null || districts.isEmpty()) {
            System.err.println("行政区划接口返回成功，但 districts 为空。请检查 cityName 是否正确。");
            return;
        }

        JSONObject district = districts.getJSONObject(0);
        String name = district.getStr("name");
        String adcode = district.getStr("adcode");
        String polyline = district.getStr("polyline");

        System.out.println("匹配到行政区: " + name + "，adcode: " + adcode);

        if (polyline == null || polyline.isEmpty()) {
            System.err.println("行政区划接口返回成功，但 polyline 为空。");
            return;
        }

        String[] polygonsStr = polyline.split("\\|");
        for (String polyStr : polygonsStr) {
            String[] pointsStr = polyStr.split(";");
            List<double[]> polygon = new ArrayList<>();

            for (String ptStr : pointsStr) {
                String[] lngLat = ptStr.split(",");
                if (lngLat.length == 2) {
                    polygon.add(new double[]{
                            Double.parseDouble(lngLat[0]),
                            Double.parseDouble(lngLat[1])
                    });
                }
            }

            if (!polygon.isEmpty()) {
                cityPolygons.add(polygon);
            }
        }

        System.out.println("成功解析边界多边形数量: " + cityPolygons.size());
    }

    /**
     * 判断点是否在任意一个多边形内
     */
    private static boolean isPointInPolygons(double lon, double lat, List<List<double[]>> polygons) {
        for (List<double[]> polygon : polygons) {
            if (isPointInPolygon(lon, lat, polygon)) {
                return true;
            }
        }
        return false;
    }

    /**
     * 核心算法：射线法 (Ray Casting) 判断经纬度是否在多边形内部
     */
    private static boolean isPointInPolygon(double lon, double lat, List<double[]> polygon) {
        boolean isInside = false;
        int i, j = polygon.size() - 1;

        for (i = 0; i < polygon.size(); i++) {
            double[] pi = polygon.get(i);
            double[] pj = polygon.get(j);

            // 如果当前点在多边形的边界线段上，或者射线穿过多边形的边
            if ((pi[1] > lat) != (pj[1] > lat) && (lon < (pj[0] - pi[0]) * (lat - pi[1]) / (pj[1] - pi[1]) + pi[0])) {
                isInside = !isInside;
            }
            j = i;
        }
        return isInside;
    }

    /**
     * 执行高德周边搜索
     */
    private static void fetchPoisAround(double lon, double lat, FileWriter writer) {
        for (int page = 1; page <= 8; page++) {
            String url = String.format(
                    "https://restapi.amap.com/v5/place/around?key=%s&keywords=%s&location=%.6f,%.6f&radius=%d&types=050000&page_size=20&page_num=%d",
                    API_KEY, "餐饮", lon, lat, (int) RADIUS, page);

            try {
                HttpRequest request = HttpRequest.newBuilder().uri(URI.create(url)).GET().build();
                String response = client.send(request, HttpResponse.BodyHandlers.ofString()).body();

                // 解析逻辑
                if (response.contains("\"pois\":[]"))
                    break; // 没数据了，跳出翻页

                JSONObject jsonObject = JSONUtil.parseObj(response);
                JSONArray pois = jsonObject.getJSONArray("pois");

                for (int i = 0; i < pois.size(); i++) {
                    JSONObject poi = pois.getJSONObject(i);
                    String poiId = poi.getStr("id");

                    // 去重逻辑：如果已经处理过该商家，则跳过
                    if (!poiIds.contains(poiId)) {

                        // 调用详情接口
                        String url2 = String.format(
                                "https://restapi.amap.com/v5/place/detail?key=%s&id=%s&show_fields=business,photos",
                                API_KEY, poiId);

                        HttpRequest request2 = HttpRequest.newBuilder().uri(URI.create(url2)).GET().build();
                        String response2 = client.send(request2, HttpResponse.BodyHandlers.ofString()).body();

                        JSONObject jsonObject2 = JSONUtil.parseObj(response2);

                        JSONArray pois1 = jsonObject2.getJSONArray("pois");

                        JSONObject poi1 = pois1.getJSONObject(0);

                        poiIds.add(poiId);
                        String line = String.format("%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n", poiId,
                                poi1.getStr("name"), poi1.getStr("type").replace(",", "，"), poi1.getStr("typecode"),
                                poi1.getStr("pname"), poi1.getStr("cityname"), poi1.getStr("adname"),
                                poi1.getStr("pcode"), poi1.getStr("adcode"), poi1.getStr("citycode"),
                                poi1.getStr("address").replace(",", "，"), poi1.getStr("location"),
                                poi1.getStr("distance"), poi1.getStr("parent"));
                        writer.write(line);
                        System.out.println("增加一个: " + poi.getStr("name"));
                    }
                }

                Thread.sleep(200); // 频率控制 (可以适当调低一点，因为无效请求已经被拦截了)
            } catch (Exception e) {
                System.err.println("请求异常: " + e.getMessage());
            }
        }
    }

    /**
     * 将米转换为纬度度数偏移
     */
    private static double metersToLatitudeDegree(double meters) {
        return meters / 111132.0;
    }

    /**
     * 将米转换为当前纬度下的经度度数偏移
     */
    private static double metersToLongitudeDegree(double meters, double lat) {
        double radians = Math.toRadians(lat);
        return meters / (111132.0 * Math.cos(radians));
    }
}

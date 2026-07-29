import type { CodingProblemInput } from "./coding";

/**
 * 内置的「经典题」种子库:Java Lambda / Stream、MySQL 标准 SQL、MongoDB 查询、程序设计,外加少量算法题。
 * 一键导入到 ip_coding_problem(按标题去重,重复导入不会产生副本),不用等 AI 也能马上开练。
 *
 * 每题题干中英各一份(面试是英文的,题面也得能读英文)。
 * 参考代码都按「适合逐字跟打」的标准写:缩进 4 空格、单行不超过 ~80 字符、全 ASCII、不带代码围栏。
 */

/** 保留缩进的代码模板:去掉首行换行与整体公共缩进(String.raw 让 \n 这类转义原样保留)。 */
function code(strings: TemplateStringsArray, ...vals: unknown[]): string {
  const raw = String.raw({ raw: strings }, ...vals);
  const lines = raw.replace(/^\n/, "").replace(/\s+$/, "").split("\n");
  const widths = lines.filter((l) => l.trim()).map((l) => (l.match(/^ */) ?? [""])[0].length);
  const indent = widths.length ? Math.min(...widths) : 0;
  return lines.map((l) => l.slice(indent)).join("\n");
}

/* ============================ Java Lambda / Stream ============================ */

const JAVA_LAMBDA: CodingProblemInput[] = [
  {
    category: "java-lambda",
    lang: "java",
    title: "Stream 过滤 + 映射 + 收集",
    difficulty: 1,
    source: "seed",
    prompt: "用 Stream 从用户列表里挑出成年人,取出他们的名字,收集成 List<String>。",
    promptEn: "Given a list of users, use the Stream API to keep only adults, extract their names, and collect them into a List<String>.",
    setup: "class User { int getAge(); String getName(); }\nList<User> users;",
    solution: code`
      List<String> names = users.stream()
              .filter(u -> u.getAge() >= 18)
              .map(User::getName)
              .collect(Collectors.toList());
    `,
    explanation:
      "filter 是中间操作(惰性),collect 是终端操作才真正触发遍历。map 里能用方法引用 User::getName 就别写 u -> u.getName()。",
  },
  {
    category: "java-lambda",
    lang: "java",
    title: "Comparator 多级排序并逆序",
    difficulty: 2,
    source: "seed",
    prompt: "把用户按年龄升序排,年龄相同再按名字排;最后整体反过来(降序)。",
    promptEn: "Sort the users by age ascending, then by name for ties, and finally reverse the whole ordering (descending).",
    setup: "List<User> users; // User: int getAge(), String getName()",
    solution: code`
      users.sort(Comparator.comparingInt(User::getAge)
              .thenComparing(User::getName)
              .reversed());
    `,
    explanation:
      "reversed() 反的是它前面「整条」比较链,不是只反最后一级。comparingInt 避免了 Integer 装箱。",
  },
  {
    category: "java-lambda",
    lang: "java",
    title: "groupingBy 分组计数",
    difficulty: 1,
    source: "seed",
    prompt: "统计每个城市有多少个用户,结果是 Map<String, Long>。",
    promptEn: "Count how many users live in each city and return the result as a Map<String, Long>.",
    setup: "List<User> users; // User: String getCity()",
    solution: code`
      Map<String, Long> countByCity = users.stream()
              .collect(Collectors.groupingBy(User::getCity, Collectors.counting()));
    `,
    explanation: "groupingBy 的第二个参数是「下游收集器」,counting() 数个数,summingInt() 求和,averagingDouble() 求均值。",
  },
  {
    category: "java-lambda",
    lang: "java",
    title: "groupingBy + mapping 分组取字段",
    difficulty: 2,
    source: "seed",
    prompt: "按城市分组,每组只保留用户名字的列表,结果是 Map<String, List<String>>。",
    promptEn: "Group users by city, keeping only their names in each group, so the result is a Map<String, List<String>>.",
    setup: "List<User> users; // User: String getCity(), String getName()",
    solution: code`
      Map<String, List<String>> namesByCity = users.stream()
              .collect(Collectors.groupingBy(User::getCity,
                      Collectors.mapping(User::getName, Collectors.toList())));
    `,
    explanation: "mapping 是「先转换再收集」的下游收集器,常和 groupingBy 搭配,免得先分组再遍历二次加工。",
  },
  {
    category: "java-lambda",
    lang: "java",
    title: "toMap 与重复键冲突",
    difficulty: 2,
    source: "seed",
    prompt: "把用户列表转成以邮箱为键的 Map;邮箱重复时保留先出现的那个(不要抛 IllegalStateException)。",
    promptEn: "Turn the user list into a map keyed by email. When two users share an email, keep the first one instead of throwing IllegalStateException.",
    setup: "List<User> users; // User: String getEmail()",
    solution: code`
      Map<String, User> byEmail = users.stream()
              .collect(Collectors.toMap(User::getEmail, u -> u, (a, b) -> a));
    `,
    explanation:
      "两参 toMap 遇到重复键会抛 IllegalStateException;第三个参数 mergeFunction 才是面试考点:(a, b) -> a 保留旧值,(a, b) -> b 用新值。",
  },
  {
    category: "java-lambda",
    lang: "java",
    title: "求和、平均与最大值",
    difficulty: 1,
    source: "seed",
    prompt: "算出订单总金额、平均金额,以及金额最大的那笔订单。",
    promptEn: "Compute the total order amount, the average amount, and the single largest order.",
    setup: "List<Order> orders; // Order: int getAmount()",
    solution: code`
      int total = orders.stream().mapToInt(Order::getAmount).sum();
      double avg = orders.stream().mapToInt(Order::getAmount).average().orElse(0);
      Optional<Order> top = orders.stream()
              .max(Comparator.comparingInt(Order::getAmount));
    `,
    explanation: "mapToInt 得到 IntStream,直接有 sum()/average()/max();average() 返回 OptionalDouble,空集合要给默认值。",
  },
  {
    category: "java-lambda",
    lang: "java",
    title: "Optional 链式取值防 NPE",
    difficulty: 1,
    source: "seed",
    prompt: "安全地取出 user.address.city,任何一层为 null 都返回 \"unknown\"。",
    promptEn: "Safely read user.address.city and fall back to \"unknown\" if any link in the chain is null.",
    setup: "User user; // User: Address getAddress();  Address: String getCity()",
    solution: code`
      String city = Optional.ofNullable(user)
              .map(User::getAddress)
              .map(Address::getCity)
              .orElse("unknown");
    `,
    explanation: "map 遇到 null 会自动短路成空 Optional。orElse 的值总会被求值,代价大的兜底用 orElseGet(() -> ...)。",
  },
  {
    category: "java-lambda",
    lang: "java",
    title: "flatMap 扁平化嵌套集合",
    difficulty: 2,
    source: "seed",
    prompt: "把所有帖子的标签汇总成一个去重、排好序的列表。",
    promptEn: "Collect the tags of every post into one distinct, sorted list.",
    setup: "List<Post> posts; // Post: List<String> getTags()",
    solution: code`
      List<String> tags = posts.stream()
              .flatMap(p -> p.getTags().stream())
              .distinct()
              .sorted()
              .collect(Collectors.toList());
    `,
    explanation: "map 得到 Stream<List<String>>,flatMap 才能摊平成 Stream<String>。distinct 依赖 equals/hashCode。",
  },
  {
    category: "java-lambda",
    lang: "java",
    title: "自定义函数式接口与方法引用",
    difficulty: 2,
    source: "seed",
    prompt: "定义一个只有一个抽象方法的计算接口,分别用 Lambda 和方法引用实现它。",
    promptEn: "Declare a functional interface with a single abstract method, then implement it once with a lambda and once with a method reference.",
    setup: "无(纯语法题)",
    solution: code`
      @FunctionalInterface
      interface Calculator {
          int apply(int a, int b);
      }

      Calculator add = (a, b) -> a + b;
      Calculator max = Math::max;
      System.out.println(add.apply(2, 3) + " " + max.apply(2, 3));
    `,
    explanation:
      "@FunctionalInterface 只是编译期校验「有且仅有一个抽象方法」。Math::max 是静态方法引用,签名对得上就能直接当实现。",
  },
  {
    category: "java-lambda",
    lang: "java",
    title: "排序取 Top 3 并拼接成字符串",
    difficulty: 2,
    source: "seed",
    prompt: "按分数从高到低取前三名的名字,拼成 [张三, 李四, 王五] 这种格式。",
    promptEn: "Take the top three users by score and join their names as [Alice, Bob, Carol].",
    setup: "List<User> users; // User: int getScore(), String getName()",
    solution: code`
      String top3 = users.stream()
              .sorted(Comparator.comparingInt(User::getScore).reversed())
              .limit(3)
              .map(User::getName)
              .collect(Collectors.joining(", ", "[", "]"));
    `,
    explanation: "joining 的三参版本自带分隔符/前缀/后缀,比手写 StringBuilder 干净。limit 放在 sorted 之后才是 Top N。",
  },
  {
    category: "java-lambda",
    lang: "java",
    title: "partitioningBy 二分与统计摘要",
    difficulty: 2,
    source: "seed",
    prompt: "按是否及格(>=60)把用户分成两堆,再一次性拿到分数的统计摘要(个数/最大/最小/平均)。",
    promptEn: "Split the users into passing (score >= 60) and failing groups, then get count/min/max/average of the scores in a single pass.",
    setup: "List<User> users; // User: int getScore()",
    solution: code`
      Map<Boolean, List<User>> parts = users.stream()
              .collect(Collectors.partitioningBy(u -> u.getScore() >= 60));
      IntSummaryStatistics stats = users.stream()
              .mapToInt(User::getScore)
              .summaryStatistics();
    `,
    explanation:
      "partitioningBy 的结果一定有 true/false 两个键(哪怕某边是空 List),比 groupingBy 布尔键更省。summaryStatistics 一遍拿齐五个指标。",
  },
  {
    category: "java-lambda",
    lang: "java",
    title: "Map 的函数式 API:merge / computeIfAbsent",
    difficulty: 2,
    source: "seed",
    prompt: "用 Map 的函数式方法做词频统计和「一键多值」的分组,再遍历打印。",
    promptEn: "Use the functional Map APIs to count word frequencies, to append to a multi-value map, and to iterate over the entries.",
    setup: "Map<String, Integer> freq;  Map<String, List<String>> index;",
    solution: code`
      freq.merge(word, 1, Integer::sum);
      index.computeIfAbsent(key, k -> new ArrayList<>()).add(item);
      freq.forEach((k, v) -> System.out.println(k + "=" + v));
    `,
    explanation:
      "merge:没有就放默认值,有了就按函数合并。computeIfAbsent 保证 value 容器存在,比 get 判空再 put 少一次查找。",
  },
];

/* ============================ MySQL ============================ */

const MYSQL: CodingProblemInput[] = [
  {
    category: "mysql",
    lang: "sql",
    title: "查第二高的薪水",
    difficulty: 2,
    source: "seed",
    prompt: "查出第二高的薪水;不存在时返回 NULL(经典题 LeetCode 176)。",
    promptEn: "Report the second highest salary, or NULL when there is no second one (LeetCode 176).",
    setup: "Employee(id INT, salary INT)",
    solution: code`
      SELECT (SELECT DISTINCT salary
                FROM Employee
               ORDER BY salary DESC
               LIMIT 1 OFFSET 1) AS SecondHighestSalary;
    `,
    explanation: "DISTINCT 去掉并列;LIMIT 1 OFFSET 1 取第二条。包成子查询是为了「没有第二名时也能返回一行 NULL」。",
  },
  {
    category: "mysql",
    lang: "sql",
    title: "每个部门薪水最高的员工",
    difficulty: 2,
    source: "seed",
    prompt: "列出每个部门里薪水最高的员工(并列都要),输出部门名、员工名、薪水。",
    promptEn: "List the highest-paid employee(s) of every department, including ties, showing department name, employee name and salary.",
    setup: "Employee(id, name, salary, departmentId)\nDepartment(id, name)",
    solution: code`
      SELECT d.name AS Department, e.name AS Employee, e.salary AS Salary
        FROM Employee e
        JOIN Department d ON d.id = e.departmentId
       WHERE (e.departmentId, e.salary) IN (
                 SELECT departmentId, MAX(salary)
                   FROM Employee
                  GROUP BY departmentId);
    `,
    explanation: "行构造器 (a, b) IN (SELECT a, MAX(b) ...) 是最短写法,并列最高薪都会保留。也可以用 RANK() 窗口函数。",
  },
  {
    category: "mysql",
    lang: "sql",
    title: "连续出现三次的数字",
    difficulty: 3,
    source: "seed",
    prompt: "找出所有至少连续出现三次的数字(LeetCode 180)。",
    promptEn: "Find all numbers that appear at least three times in a row (LeetCode 180).",
    setup: "Logs(id INT 自增连续, num INT)",
    solution: code`
      SELECT DISTINCT l1.num AS ConsecutiveNums
        FROM Logs l1
        JOIN Logs l2 ON l2.id = l1.id + 1 AND l2.num = l1.num
        JOIN Logs l3 ON l3.id = l1.id + 2 AND l3.num = l1.num;
    `,
    explanation: "自连接三次、用 id 偏移表示「相邻」。窗口函数版可以用 LAG/LEAD 或 row_number 差分分组。",
  },
  {
    category: "mysql",
    lang: "sql",
    title: "删除重复的邮箱只留 id 最小的",
    difficulty: 2,
    source: "seed",
    prompt: "同一个邮箱只保留 id 最小的那条,其余删掉(LeetCode 196)。",
    promptEn: "Delete duplicate emails, keeping only the row with the smallest id for each email (LeetCode 196).",
    setup: "Person(id INT PRIMARY KEY, email VARCHAR(255))",
    solution: code`
      DELETE p1
        FROM Person p1
        JOIN Person p2 ON p1.email = p2.email AND p1.id > p2.id;
    `,
    explanation: "MySQL 的多表 DELETE 要在 DELETE 后写别名指明删哪张表。别用 DELETE ... WHERE id NOT IN (SELECT ... FROM Person),同表子查询会报错。",
  },
  {
    category: "mysql",
    lang: "sql",
    title: "窗口函数做并列排名",
    difficulty: 2,
    source: "seed",
    prompt: "按分数降序排名,分数相同排名相同且名次不跳号(LeetCode 178)。",
    promptEn: "Rank the scores from high to low so that equal scores share a rank and there are no gaps in the ranking (LeetCode 178).",
    setup: "Scores(id INT, score DECIMAL(3,2))",
    solution: code`
      SELECT score,
             DENSE_RANK() OVER (ORDER BY score DESC) AS 'rank'
        FROM Scores
       ORDER BY score DESC;
    `,
    explanation: "RANK 会跳号(1,1,3),DENSE_RANK 不跳(1,1,2),ROW_NUMBER 强制唯一。rank 是保留字,要加反引号或引号。",
  },
  {
    category: "mysql",
    lang: "sql",
    title: "每个部门薪水前三名(分组 Top N)",
    difficulty: 3,
    source: "seed",
    prompt: "取每个部门薪水最高的前三名。",
    promptEn: "Return the three highest-paid employees of each department.",
    setup: "employee(id, name, salary, department)",
    solution: code`
      SELECT department, name, salary
        FROM (SELECT department, name, salary,
                     ROW_NUMBER() OVER (PARTITION BY department
                                        ORDER BY salary DESC) AS rn
                FROM employee) t
       WHERE t.rn <= 3
       ORDER BY department, salary DESC;
    `,
    explanation: "分组 Top N 的标准套路:PARTITION BY 分组 + 窗口函数编号 + 外层过滤。窗口函数不能直接写在 WHERE 里,必须套子查询。",
  },
  {
    category: "mysql",
    lang: "sql",
    title: "GROUP BY + HAVING 聚合筛选",
    difficulty: 1,
    source: "seed",
    prompt: "统计每个客户已支付订单的笔数和总额,只保留总额超过 1000 的,按总额降序。",
    promptEn: "For each customer, count paid orders and sum their amounts, keeping only customers who spent more than 1000, ordered by total descending.",
    setup: "orders(id, customer_id, amount, status, created_at)",
    solution: code`
      SELECT customer_id,
             COUNT(*) AS order_count,
             SUM(amount) AS total
        FROM orders
       WHERE status = 'PAID'
       GROUP BY customer_id
      HAVING SUM(amount) > 1000
       ORDER BY total DESC;
    `,
    explanation: "WHERE 在分组前过滤行,HAVING 在分组后过滤组 —— 这是最常被追问的区别。",
  },
  {
    category: "mysql",
    lang: "sql",
    title: "LEFT JOIN 找从没下过单的客户",
    difficulty: 1,
    source: "seed",
    prompt: "列出一次订单都没有的客户。",
    promptEn: "List the customers who have never placed an order.",
    setup: "customers(id, name)\norders(id, customer_id)",
    solution: code`
      SELECT c.id, c.name
        FROM customers c
        LEFT JOIN orders o ON o.customer_id = c.id
       WHERE o.id IS NULL;
    `,
    explanation: "LEFT JOIN + 右表主键 IS NULL 就是「反连接」。等价写法 NOT EXISTS 通常也走得动索引,NOT IN 遇到 NULL 会出坑。",
  },
  {
    category: "mysql",
    lang: "sql",
    title: "按月统计销售额",
    difficulty: 1,
    source: "seed",
    prompt: "按自然月统计订单数与销售额,金额保留两位小数,按月份升序。",
    promptEn: "Report the number of orders and the revenue per calendar month, rounded to two decimals and ordered by month.",
    setup: "orders(id, amount DECIMAL(10,2), created_at DATETIME)",
    solution: code`
      SELECT DATE_FORMAT(created_at, '%Y-%m') AS month,
             COUNT(*) AS orders,
             ROUND(SUM(amount), 2) AS revenue
        FROM orders
       GROUP BY month
       ORDER BY month;
    `,
    explanation: "DATE_FORMAT 的 %Y-%m 得到 2026-07 这种月份键。注意对 created_at 套函数会让索引失效,大表按范围过滤更好。",
  },
  {
    category: "mysql",
    lang: "sql",
    title: "员工薪水高于其经理",
    difficulty: 1,
    source: "seed",
    prompt: "找出薪水比自己直属经理还高的员工(LeetCode 181)。",
    promptEn: "Find the employees who earn more than their direct manager (LeetCode 181).",
    setup: "Employee(id, name, salary, managerId)",
    solution: code`
      SELECT e.name AS Employee
        FROM Employee e
        JOIN Employee m ON m.id = e.managerId
       WHERE e.salary > m.salary;
    `,
    explanation: "同一张表 JOIN 自己叫自连接,靠别名区分「员工行」和「经理行」。",
  },
  {
    category: "mysql",
    lang: "sql",
    title: "UPDATE 关联另一张表",
    difficulty: 2,
    source: "seed",
    prompt: "给所有 VIP 客户的新订单打九折(discount 设为 0.1)。",
    promptEn: "Give every new order of a VIP customer a 10% discount (set discount to 0.1).",
    setup: "orders(id, customer_id, discount, status)\ncustomers(id, level)",
    solution: code`
      UPDATE orders o
        JOIN customers c ON c.id = o.customer_id
         SET o.discount = 0.1
       WHERE c.level = 'VIP' AND o.status = 'NEW';
    `,
    explanation: "MySQL 的 UPDATE 支持直接 JOIN,SET 写在 JOIN 之后。执行前先把它改成 SELECT 跑一遍确认影响行数。",
  },
  {
    category: "mysql",
    lang: "sql",
    title: "事务转账与行锁",
    difficulty: 2,
    source: "seed",
    prompt: "在一个事务里把 1 号账户的 100 块转给 2 号账户,读的时候加行锁。",
    promptEn: "Transfer 100 from account 1 to account 2 inside a single transaction, locking the row while reading it.",
    setup: "account(id INT PRIMARY KEY, balance DECIMAL(10,2)) InnoDB",
    solution: code`
      START TRANSACTION;
      SELECT balance FROM account WHERE id = 1 FOR UPDATE;
      UPDATE account SET balance = balance - 100 WHERE id = 1;
      UPDATE account SET balance = balance + 100 WHERE id = 2;
      COMMIT;
    `,
    explanation: "SELECT ... FOR UPDATE 加排他行锁,防止并发扣成负数。按固定顺序锁多行可以降低死锁概率。",
  },
  {
    category: "mysql",
    lang: "sql",
    title: "建复合索引并看执行计划",
    difficulty: 2,
    source: "seed",
    prompt: "为「查某客户最近 10 笔订单」建合适的索引,并查看执行计划。",
    promptEn: "Create a suitable index for \"the 10 most recent orders of one customer\" and inspect the query plan.",
    setup: "orders(id, customer_id, amount, created_at)",
    solution: code`
      CREATE INDEX idx_orders_customer_created
          ON orders (customer_id, created_at);

      EXPLAIN SELECT id, amount
                FROM orders
               WHERE customer_id = 42
               ORDER BY created_at DESC
               LIMIT 10;
    `,
    explanation:
      "复合索引按最左前缀生效:等值列在前、排序列在后,ORDER BY 就能直接吃索引顺序,免掉 filesort。EXPLAIN 看 key / rows / Extra。",
  },
];

/* ============================ MongoDB ============================ */

const MONGODB: CodingProblemInput[] = [
  {
    category: "mongodb",
    lang: "javascript",
    title: "find 查询:条件 + 投影 + 排序 + 分页",
    difficulty: 1,
    source: "seed",
    prompt: "查出成年的活跃用户,只要 name 和 age 字段,按年龄倒序,取第 3 页(每页 10 条)。",
    promptEn: "Find active adult users, return only name and age, sort by age descending and fetch page 3 (10 per page).",
    setup: "集合 users: { _id, name, age, status }",
    solution: code`
      db.users.find(
          { age: { $gte: 18 }, status: "active" },
          { name: 1, age: 1, _id: 0 }
      ).sort({ age: -1 }).skip(20).limit(10);
    `,
    explanation: "第二个参数是投影,_id 要显式写 0 才不返回。skip 在大偏移量下很慢,线上分页更推荐用上一页最后一条的值做游标。",
  },
  {
    category: "mongodb",
    lang: "javascript",
    title: "聚合管道:$match + $group + $sort",
    difficulty: 2,
    source: "seed",
    prompt: "统计每个客户已支付订单的总额和笔数,取消费最多的前 10 名。",
    promptEn: "Aggregate the paid orders per customer into a total and a count, then return the ten biggest spenders.",
    setup: "集合 orders: { _id, customerId, amount, status }",
    solution: code`
      db.orders.aggregate([
          { $match: { status: "PAID" } },
          { $group: {
              _id: "$customerId",
              total: { $sum: "$amount" },
              count: { $sum: 1 }
          } },
          { $sort: { total: -1 } },
          { $limit: 10 }
      ]);
    `,
    explanation: "$match 尽量放最前面(能用索引、先减少文档量);$group 的 _id 就是分组键,$sum: 1 等价于计数。",
  },
  {
    category: "mongodb",
    lang: "javascript",
    title: "$lookup 关联另一个集合",
    difficulty: 2,
    source: "seed",
    prompt: "把订单关联到客户集合,输出金额和客户名。",
    promptEn: "Join orders to the customers collection and output the amount together with the customer name.",
    setup: "orders: { customerId, amount }\ncustomers: { _id, name }",
    solution: code`
      db.orders.aggregate([
          { $lookup: {
              from: "customers",
              localField: "customerId",
              foreignField: "_id",
              as: "customer"
          } },
          { $unwind: "$customer" },
          { $project: { _id: 0, amount: 1, name: "$customer.name" } }
      ]);
    `,
    explanation: "$lookup 的结果永远是数组,所以后面通常跟 $unwind 摊平。它相当于左外连接,匹配不到时数组为空。",
  },
  {
    category: "mongodb",
    lang: "javascript",
    title: "$unwind 统计数组元素",
    difficulty: 2,
    source: "seed",
    prompt: "统计所有帖子里每个标签出现了多少次,按次数倒序。",
    promptEn: "Count how many times each tag is used across all posts, most used first.",
    setup: "集合 posts: { _id, title, tags: [String] }",
    solution: code`
      db.posts.aggregate([
          { $unwind: "$tags" },
          { $group: { _id: "$tags", count: { $sum: 1 } } },
          { $sort: { count: -1, _id: 1 } }
      ]);
    `,
    explanation: "$unwind 把一篇有 3 个标签的文档拆成 3 条,再分组统计。次数相同时用 _id 兜底排序,结果才稳定。",
  },
  {
    category: "mongodb",
    lang: "javascript",
    title: "updateMany:$set / $inc / $currentDate",
    difficulty: 1,
    source: "seed",
    prompt: "把有库存的图书标记为促销,库存各减 1,并刷新更新时间。",
    promptEn: "Mark every in-stock book as on sale, decrement its stock by one and refresh its updated timestamp.",
    setup: "集合 products: { _id, category, stock, onSale, updatedAt }",
    solution: code`
      db.products.updateMany(
          { category: "book", stock: { $gt: 0 } },
          {
              $set: { onSale: true },
              $inc: { stock: -1 },
              $currentDate: { updatedAt: true }
          }
      );
    `,
    explanation: "更新必须用更新操作符包起来;直接传整个文档是「替换」语义,会把没写的字段丢掉。",
  },
  {
    category: "mongodb",
    lang: "javascript",
    title: "upsert 实现自增序列",
    difficulty: 2,
    source: "seed",
    prompt: "用一条命令实现「计数器不存在就创建、存在就自增」,并拿到自增后的文档。",
    promptEn: "Increment a counter in one atomic command, creating the document if it does not exist, and return the updated document.",
    setup: "集合 counters: { _id: String, seq: Number }",
    solution: code`
      db.counters.findOneAndUpdate(
          { _id: "orderId" },
          { $inc: { seq: 1 } },
          { upsert: true, returnDocument: "after" }
      );
    `,
    explanation: "upsert 让「查不到就插入」变成一次原子操作,不会有并发下的读-改-写竞态。returnDocument: 'after' 返回更新后的值。",
  },
  {
    category: "mongodb",
    lang: "javascript",
    title: "建索引与看执行计划",
    difficulty: 2,
    source: "seed",
    prompt: "为「按客户查最近订单」建复合索引,给邮箱建唯一索引,并查看查询是否走了索引。",
    promptEn: "Create a compound index for \"recent orders by customer\", a unique index on email, and check whether the query uses an index.",
    setup: "orders: { customerId, createdAt }\nusers: { email }",
    solution: code`
      db.orders.createIndex({ customerId: 1, createdAt: -1 });
      db.users.createIndex({ email: 1 }, { unique: true });

      db.orders.find({ customerId: 42 })
               .sort({ createdAt: -1 })
               .explain("executionStats");
    `,
    explanation: "复合索引同样讲最左前缀:等值字段在前、排序字段在后。执行计划里看 stage 是 IXSCAN 还是 COLLSCAN。",
  },
  {
    category: "mongodb",
    lang: "javascript",
    title: "数组字段的更新与查询",
    difficulty: 2,
    source: "seed",
    prompt: "给用户打上不重复的标签、把日志追加到只保留最近 10 条的数组;再查出数学成绩 90 分以上的用户。",
    promptEn: "Add a tag without duplicating it, append a log entry keeping only the last 10, then find users whose math score is at least 90.",
    setup: "users: { _id, tags: [String], logs: [Object], scores: [{ subject, value }] }",
    solution: code`
      db.users.updateOne(
          { _id: 1 },
          {
              $addToSet: { tags: "vip" },
              $push: { logs: { $each: [{ at: new Date() }], $slice: -10 } }
          }
      );

      db.users.find({
          scores: { $elemMatch: { subject: "math", value: { $gte: 90 } } }
      });
    `,
    explanation:
      "$addToSet 去重追加,$push + $slice 做定长数组。$elemMatch 要求「同一个数组元素」同时满足多个条件,分开写会误匹配。",
  },
  {
    category: "mongodb",
    lang: "javascript",
    title: "$project 计算字段:$cond / $ifNull",
    difficulty: 2,
    source: "seed",
    prompt: "输出用户名、按分数算出的等级(>=90 为 A,否则 B),以及城市(缺失时给 unknown)。",
    promptEn: "Project the name, a level computed from the score (A when >= 90, otherwise B), and the city defaulting to \"unknown\" when missing.",
    setup: "users: { name, score, address: { city } }",
    solution: code`
      db.users.aggregate([
          { $project: {
              _id: 0,
              name: 1,
              level: { $cond: [{ $gte: ["$score", 90] }, "A", "B"] },
              city: { $ifNull: ["$address.city", "unknown"] }
          } }
      ]);
    `,
    explanation: "聚合表达式里字段要写成 \"$字段名\"。$cond 是三元表达式,$ifNull 给缺失字段兜底,嵌套字段用点号取。",
  },
  {
    category: "mongodb",
    lang: "javascript",
    title: "$facet 一次拿到分页数据和总数",
    difficulty: 3,
    source: "seed",
    prompt: "一次聚合同时返回当前页的 10 条订单和满足条件的总条数。",
    promptEn: "In one aggregation, return both the current page of 10 orders and the total number of matching documents.",
    setup: "集合 orders: { status, createdAt }",
    solution: code`
      db.orders.aggregate([
          { $match: { status: "PAID" } },
          { $facet: {
              rows: [
                  { $sort: { createdAt: -1 } },
                  { $skip: 0 },
                  { $limit: 10 }
              ],
              total: [ { $count: "n" } ]
          } }
      ]);
    `,
    explanation: "$facet 让多条子管道共享同一份输入,省掉「查一次数据再 count 一次」的两次往返。",
  },
];

/* ============================ 程序设计(写整段:类 / 接口 / 并发 / 设计模式) ============================ */

const DESIGN: CodingProblemInput[] = [
  {
    category: "design",
    lang: "java",
    title: "线程安全单例(静态内部类)",
    difficulty: 2,
    source: "seed",
    prompt: "写一个线程安全、延迟加载的单例,不要用 synchronized。",
    promptEn: "Write a thread-safe, lazily initialized singleton without using synchronized.",
    setup: "无外部依赖",
    solution: code`
      public class Config {

          private Config() {}

          private static class Holder {
              static final Config INSTANCE = new Config();
          }

          public static Config getInstance() {
              return Holder.INSTANCE;
          }
      }
    `,
    explanation:
      "静态内部类在第一次被引用时才加载,类加载过程由 JVM 保证线程安全 —— 既延迟又不用锁。私有构造挡住 new;要防反射/序列化就用枚举单例。",
  },
  {
    category: "design",
    lang: "java",
    title: "LRU 缓存(LinkedHashMap)",
    difficulty: 2,
    source: "seed",
    prompt: "用 LinkedHashMap 实现一个定容 LRU 缓存:满了就淘汰最久没被访问的键。",
    promptEn: "Implement a fixed-capacity LRU cache on top of LinkedHashMap that evicts the least recently used key when full.",
    setup: "class LruCache<K, V> extends LinkedHashMap<K, V>",
    solution: code`
      public class LruCache<K, V> extends LinkedHashMap<K, V> {

          private final int capacity;

          public LruCache(int capacity) {
              super(capacity, 0.75f, true);
              this.capacity = capacity;
          }

          @Override
          protected boolean removeEldestEntry(Map.Entry<K, V> eldest) {
              return size() > capacity;
          }
      }
    `,
    explanation:
      "构造器第三个参数 accessOrder=true 才是 LRU 的关键(按访问顺序排,而不是插入顺序)。追问通常是「怎么做到 O(1)」:哈希表 + 双向链表,LinkedHashMap 本身就是这个结构。",
  },
  {
    category: "design",
    lang: "java",
    title: "Builder 模式构建对象",
    difficulty: 2,
    source: "seed",
    prompt: "给一个字段较多的不可变类写 Builder,支持链式调用。",
    promptEn: "Give an immutable class with several fields a Builder that supports method chaining.",
    setup: "class User { String name; int age; }",
    solution: code`
      public class User {

          private final String name;
          private final int age;

          private User(Builder builder) {
              this.name = builder.name;
              this.age = builder.age;
          }

          public static class Builder {

              private String name;
              private int age;

              public Builder name(String name) {
                  this.name = name;
                  return this;
              }

              public Builder age(int age) {
                  this.age = age;
                  return this;
              }

              public User build() {
                  return new User(this);
              }
          }
      }
    `,
    explanation:
      "构造器私有 + 静态内部 Builder:字段多、可选参数多时比重载构造器清晰,还能在 build() 里集中做校验,对象建成后不可变。",
  },
  {
    category: "design",
    lang: "java",
    title: "策略模式:用 Map 干掉 if-else",
    difficulty: 2,
    source: "seed",
    prompt: "按会员等级算折扣。用「策略表」代替一长串 if-else,新增等级不用改计算方法。",
    promptEn: "Compute a discount by membership level. Replace the long if-else chain with a strategy map so adding a level does not touch the calculation method.",
    setup: "BigDecimal price;  String level;",
    solution: code`
      public class DiscountService {

          private final Map<String, UnaryOperator<BigDecimal>> rules =
                  new HashMap<>();

          public DiscountService() {
              rules.put("VIP", p -> p.multiply(new BigDecimal("0.8")));
              rules.put("NEW", p -> p.subtract(BigDecimal.TEN));
          }

          public BigDecimal apply(String level, BigDecimal price) {
              return rules.getOrDefault(level, p -> p).apply(price);
          }
      }
    `,
    explanation:
      "策略 = 把「怎么算」变成可注册的对象。getOrDefault 给了兜底策略(原价),满足开闭原则:加规则只改注册处。",
  },
  {
    category: "design",
    lang: "java",
    title: "生产者消费者(BlockingQueue)",
    difficulty: 2,
    source: "seed",
    prompt: "用阻塞队列写一对生产者/消费者,正确处理 InterruptedException。",
    promptEn: "Write a producer and a consumer around a blocking queue, handling InterruptedException correctly.",
    setup: "BlockingQueue<String> queue = new ArrayBlockingQueue<>(100);",
    solution: code`
      Runnable producer = () -> {
          try {
              queue.put("job");
          } catch (InterruptedException e) {
              Thread.currentThread().interrupt();
          }
      };

      Runnable consumer = () -> {
          try {
              String job = queue.take();
              System.out.println(job);
          } catch (InterruptedException e) {
              Thread.currentThread().interrupt();
          }
      };
    `,
    explanation:
      "put/take 自带阻塞和锁,不用手写 wait/notify。catch 到 InterruptedException 一定要把中断标志补回去(Thread.currentThread().interrupt()),否则上层再也感知不到取消。",
  },
  {
    category: "design",
    lang: "java",
    title: "线程池提交任务并收结果",
    difficulty: 2,
    source: "seed",
    prompt: "用固定大小线程池并行跑 10 个任务,收集全部结果,最后确保线程池被关闭。",
    promptEn: "Run ten tasks in parallel on a fixed-size thread pool, collect every result, and make sure the pool is shut down at the end.",
    setup: "无(标准库 java.util.concurrent)",
    solution: code`
      ExecutorService pool = Executors.newFixedThreadPool(4);
      try {
          List<Future<Integer>> futures = new ArrayList<>();
          for (int i = 0; i < 10; i++) {
              int n = i;
              futures.add(pool.submit(() -> n * n));
          }
          for (Future<Integer> future : futures) {
              System.out.println(future.get());
          }
      } finally {
          pool.shutdown();
      }
    `,
    explanation:
      "lambda 只能捕获 effectively final 的变量,所以要把 i 复制成 n。Future.get() 会阻塞到任务完成;shutdown 放 finally,否则异常时线程池泄漏。生产上别用 Executors 的无界队列工厂,自己 new ThreadPoolExecutor 设边界。",
  },
  {
    category: "design",
    lang: "java",
    title: "CompletableFuture 并行编排",
    difficulty: 3,
    source: "seed",
    prompt: "并行调用两个远程接口,合并结果,任一失败给兜底值。",
    promptEn: "Call two remote services in parallel, combine their results, and fall back to a default value if either one fails.",
    setup: "String loadUser(long id);  String loadOrders(long id);",
    solution: code`
      CompletableFuture<String> user =
              CompletableFuture.supplyAsync(() -> loadUser(id));
      CompletableFuture<String> orders =
              CompletableFuture.supplyAsync(() -> loadOrders(id));

      String result = user.thenCombine(orders, (u, o) -> u + " / " + o)
              .exceptionally(e -> "fallback")
              .join();
    `,
    explanation:
      "thenCombine 等两个都完成再合并,总耗时取决于慢的那个而不是相加。exceptionally 是兜底,join 才真正阻塞取值。生产上记得传自定义线程池,别都挤 ForkJoinPool.commonPool。",
  },
  {
    category: "design",
    lang: "java",
    title: "正确实现 equals 与 hashCode",
    difficulty: 2,
    source: "seed",
    prompt: "给实体类实现 equals 和 hashCode(按邮箱和年龄判定相等)。",
    promptEn: "Implement equals and hashCode for an entity class, treating email and age as its identity.",
    setup: "class User { String email; int age; }",
    solution: code`
      @Override
      public boolean equals(Object o) {
          if (this == o) return true;
          if (o == null || getClass() != o.getClass()) return false;
          User user = (User) o;
          return age == user.age && Objects.equals(email, user.email);
      }

      @Override
      public int hashCode() {
          return Objects.hash(email, age);
      }
    `,
    explanation:
      "两者必须成对重写:相等的对象 hashCode 必须相同,否则放进 HashMap/HashSet 就找不回来。用 Objects.equals/hash 顺带处理 null。",
  },
  {
    category: "design",
    lang: "java",
    title: "不可变值对象",
    difficulty: 2,
    source: "seed",
    prompt: "设计一个不可变类:字段只读,集合字段要防御性拷贝,修改返回新对象。",
    promptEn: "Design an immutable class: read-only fields, defensive copies for collection fields, and mutations that return a new instance.",
    setup: "class Money { BigDecimal amount; List<String> tags; }",
    solution: code`
      public final class Money {

          private final BigDecimal amount;
          private final List<String> tags;

          public Money(BigDecimal amount, List<String> tags) {
              this.amount = amount;
              this.tags = List.copyOf(tags);
          }

          public Money plus(BigDecimal delta) {
              return new Money(amount.add(delta), tags);
          }
      }
    `,
    explanation:
      "final class + final 字段 + 不给 setter 只是第一步;集合必须 List.copyOf 拷一份,否则调用方改外面那个 list 就把你的对象改了。不可变对象天生线程安全。",
  },
  {
    category: "design",
    lang: "java",
    title: "泛型仓储接口 + 内存实现",
    difficulty: 2,
    source: "seed",
    prompt: "定义一个泛型 Repository 接口(实体类型和主键类型都泛型化),再给一个内存实现。",
    promptEn: "Define a generic Repository interface parameterized by entity type and id type, then provide an in-memory implementation.",
    setup: "实体 User,主键 Long",
    solution: code`
      public interface Repository<T, ID> {

          Optional<T> findById(ID id);

          T save(T entity);
      }

      public class InMemoryUserRepo implements Repository<User, Long> {

          private final Map<Long, User> store = new ConcurrentHashMap<>();

          @Override
          public Optional<User> findById(Long id) {
              return Optional.ofNullable(store.get(id));
          }

          @Override
          public User save(User user) {
              store.put(user.getId(), user);
              return user;
          }
      }
    `,
    explanation:
      "面向接口编程:上层依赖 Repository,换成 JPA / MyBatis 实现不用改业务代码,测试时直接注内存实现。返回 Optional 而不是 null,把「可能没有」写进签名里。",
  },
];

/* ============================ 算法(偶尔来一道) ============================ */

const ALGORITHM: CodingProblemInput[] = [
  {
    category: "algorithm",
    lang: "java",
    title: "两数之和(哈希表一次遍历)",
    difficulty: 1,
    source: "seed",
    prompt: "在数组里找出两个数,使它们的和等于目标值,返回下标(LeetCode 1)。",
    promptEn: "Return the indices of the two numbers in the array that add up to the target (LeetCode 1).",
    setup: "int[] nums, int target",
    solution: code`
      public int[] twoSum(int[] nums, int target) {
          Map<Integer, Integer> seen = new HashMap<>();
          for (int i = 0; i < nums.length; i++) {
              int need = target - nums[i];
              if (seen.containsKey(need)) {
                  return new int[] { seen.get(need), i };
              }
              seen.put(nums[i], i);
          }
          return new int[0];
      }
    `,
    explanation: "边遍历边把「见过的值 → 下标」记下来,查补数是 O(1),整体 O(n) 时间 O(n) 空间。",
  },
  {
    category: "algorithm",
    lang: "java",
    title: "反转链表(迭代版)",
    difficulty: 1,
    source: "seed",
    prompt: "原地反转单链表并返回新头结点(LeetCode 206)。",
    promptEn: "Reverse a singly linked list in place and return the new head (LeetCode 206).",
    setup: "class ListNode { int val; ListNode next; }",
    solution: code`
      public ListNode reverseList(ListNode head) {
          ListNode prev = null;
          while (head != null) {
              ListNode next = head.next;
              head.next = prev;
              prev = head;
              head = next;
          }
          return prev;
      }
    `,
    explanation: "三个指针滚动:先存下一个,再掉头,再一起前移。忘了先存 next 就会把链表断掉 —— 面试最常见的翻车点。",
  },
  {
    category: "algorithm",
    lang: "java",
    title: "二分查找",
    difficulty: 1,
    source: "seed",
    prompt: "在升序数组里查目标值,找到返回下标,否则返回 -1。",
    promptEn: "Search a sorted array for the target, returning its index or -1 when it is absent.",
    setup: "int[] nums 已升序排好",
    solution: code`
      public int binarySearch(int[] nums, int target) {
          int lo = 0, hi = nums.length - 1;
          while (lo <= hi) {
              int mid = lo + (hi - lo) / 2;
              if (nums[mid] == target) return mid;
              if (nums[mid] < target) lo = mid + 1;
              else hi = mid - 1;
          }
          return -1;
      }
    `,
    explanation: "mid 用 lo + (hi - lo) / 2 而不是 (lo + hi) / 2,避免大数相加溢出。闭区间写法配 lo <= hi。",
  },
  {
    category: "algorithm",
    lang: "java",
    title: "无重复字符的最长子串(滑动窗口)",
    difficulty: 2,
    source: "seed",
    prompt: "求字符串中不含重复字符的最长子串长度(LeetCode 3)。",
    promptEn: "Return the length of the longest substring without repeating characters (LeetCode 3).",
    setup: "String s",
    solution: code`
      public int lengthOfLongestSubstring(String s) {
          Map<Character, Integer> last = new HashMap<>();
          int best = 0, start = 0;
          for (int i = 0; i < s.length(); i++) {
              char c = s.charAt(i);
              if (last.containsKey(c) && last.get(c) >= start) {
                  start = last.get(c) + 1;
              }
              last.put(c, i);
              best = Math.max(best, i - start + 1);
          }
          return best;
      }
    `,
    explanation: "窗口左边界只前进不后退:遇到重复字符时,直接跳到「上次出现位置 + 1」。O(n)。",
  },
  {
    category: "algorithm",
    lang: "java",
    title: "最大子数组和(Kadane)",
    difficulty: 2,
    source: "seed",
    prompt: "求连续子数组的最大和(LeetCode 53)。",
    promptEn: "Return the largest sum of any contiguous subarray (LeetCode 53).",
    setup: "int[] nums,至少一个元素",
    solution: code`
      public int maxSubArray(int[] nums) {
          int best = nums[0], cur = nums[0];
          for (int i = 1; i < nums.length; i++) {
              cur = Math.max(nums[i], cur + nums[i]);
              best = Math.max(best, cur);
          }
          return best;
      }
    `,
    explanation: "cur 表示「以 i 结尾的最大和」:前面那段是负担就丢掉重开。一维 DP 压成两个变量,O(n) 时间 O(1) 空间。",
  },
  {
    category: "algorithm",
    lang: "java",
    title: "二叉树层序遍历(BFS)",
    difficulty: 2,
    source: "seed",
    prompt: "按层输出二叉树的节点值,每层一个 List(LeetCode 102)。",
    promptEn: "Return the node values of a binary tree level by level, one list per level (LeetCode 102).",
    setup: "class TreeNode { int val; TreeNode left, right; }",
    solution: code`
      public List<List<Integer>> levelOrder(TreeNode root) {
          List<List<Integer>> res = new ArrayList<>();
          if (root == null) return res;
          Queue<TreeNode> queue = new LinkedList<>();
          queue.offer(root);
          while (!queue.isEmpty()) {
              int size = queue.size();
              List<Integer> level = new ArrayList<>();
              for (int i = 0; i < size; i++) {
                  TreeNode node = queue.poll();
                  level.add(node.val);
                  if (node.left != null) queue.offer(node.left);
                  if (node.right != null) queue.offer(node.right);
              }
              res.add(level);
          }
          return res;
      }
    `,
    explanation: "进循环先记下当前队列长度 size,这一轮只弹 size 个 —— 这就是「分层」的关键。",
  },
  {
    category: "algorithm",
    lang: "java",
    title: "快速排序(Lomuto 分区)",
    difficulty: 3,
    source: "seed",
    prompt: "手写快速排序,对 [lo, hi] 区间原地排序。",
    promptEn: "Implement quicksort so that it sorts the range [lo, hi] of the array in place.",
    setup: "int[] a, int lo, int hi",
    solution: code`
      public void quickSort(int[] a, int lo, int hi) {
          if (lo >= hi) return;
          int pivot = a[hi], i = lo;
          for (int j = lo; j < hi; j++) {
              if (a[j] < pivot) {
                  swap(a, i, j);
                  i++;
              }
          }
          swap(a, i, hi);
          quickSort(a, lo, i - 1);
          quickSort(a, i + 1, hi);
      }
    `,
    explanation: "以最后一个元素为基准,i 指向「小于区」的右边界。平均 O(n log n),已排好序的输入会退化成 O(n^2),可随机选 pivot 缓解。",
  },
  {
    category: "algorithm",
    lang: "java",
    title: "爬楼梯(滚动数组 DP)",
    difficulty: 1,
    source: "seed",
    prompt: "每次爬 1 或 2 阶,求爬到第 n 阶有多少种走法(LeetCode 70)。",
    promptEn: "You can climb 1 or 2 steps at a time; count the distinct ways to reach step n (LeetCode 70).",
    setup: "int n >= 1",
    solution: code`
      public int climbStairs(int n) {
          int prev = 1, cur = 1;
          for (int i = 2; i <= n; i++) {
              int next = prev + cur;
              prev = cur;
              cur = next;
          }
          return cur;
      }
    `,
    explanation: "递推就是斐波那契:f(n) = f(n-1) + f(n-2)。只依赖前两项,所以数组能压成两个变量。",
  },
];

export const CODING_SEED: CodingProblemInput[] = [
  ...JAVA_LAMBDA,
  ...MYSQL,
  ...MONGODB,
  ...DESIGN,
  ...ALGORITHM,
];

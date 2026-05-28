---
title: "密码学工程实践：哈希、签名与密钥存储"
categories: [架构设计]
location: 西安
render_with_liquid: false
---

### 引言

"我们用MD5加密密码"——每次听到这话，我的后背就发凉。MD5不是加密，是哈希；而且作为密码哈希，它早已不安全。密码学的"常识"充满了误区，稍有不慎就是安全事故。

在一个项目中，我发现团队把API签名密钥硬编码在代码里，git history中清晰可见。另一个项目用了SHA-256做密码哈希——确实比MD5强，但仍然不适合密码存储（因为太快了）。

本文聚焦密码学在后端工程中的实际应用：密码存储该用什么、接口签名怎么做、密钥放在哪里。不讲数学推导，只讲工程正确实践。

---

### 1. 密码哈希：为什么"快"是敌人

| 算法 | 速度 | 是否适合密码 | 原因 |
|------|------|-------------|------|
| MD5 | ~6 GB/s | ❌ | 碰撞已被破解，速度太快 |
| SHA-256 | ~2 GB/s | ❌ | 无碰撞但速度太快，GPU暴力破解轻松 |
| bcrypt | ~4次/s (cost=12) | ✅ | 刻意慢，内存硬化 |
| scrypt | 可调 | ✅ | 内存密集，抗ASIC |
| **Argon2id** | 可调 | ✅✅ | 2015冠军，抗GPU/ASIC，推荐 |

**为什么密码哈希需要"慢"？**

```
攻击者破解密码的成本：

  SHA-256 (GPU: RTX 4090):
    速度: ~10 亿次/秒
    破解 8位数字密码(10^8种): 0.1秒
    破解 8位字母数字(62^8种): ~218天

  bcrypt (cost=12):
    速度: ~50次/秒 (同一张GPU)
    破解 8位数字密码: 23天
    破解 8位字母数字: 不可行

  Argon2id (t=3, m=64MB):
    速度: ~10次/秒 (受内存限制)
    破解 8位数字密码: 115天
    破解 8位字母数字: 不可行

  密码哈希的"慢"是故意的——让暴力破解在经济上不可行。
```

#### Argon2id 推荐参数

```cpp
#include <argon2.h>  // libargon2
#include <string>
#include <vector>
#include <random>

struct PasswordHash {
    std::string hash;
    std::string salt;
};

// 生成密码哈希
PasswordHash hashPassword(const std::string& password) {
    // 生成16字节随机salt
    std::vector<uint8_t> salt(16);
    std::random_device rd;
    for (auto& b : salt) b = rd();
    
    // Argon2id参数（OWASP推荐）
    const uint32_t t_cost = 3;        // 迭代次数
    const uint32_t m_cost = 65536;    // 内存使用: 64MB
    const uint32_t parallelism = 4;   // 并行线程数
    const size_t hash_len = 32;       // 输出长度: 32字节
    
    std::vector<uint8_t> hash(hash_len);
    
    int rc = argon2id_hash_raw(
        t_cost, m_cost, parallelism,
        password.c_str(), password.size(),
        salt.data(), salt.size(),
        hash.data(), hash.size()
    );
    
    if (rc != ARGON2_OK) {
        throw std::runtime_error(argon2_error_message(rc));
    }
    
    // 返回Base64编码的hash和salt
    return {base64Encode(hash), base64Encode(salt)};
}

// 验证密码
bool verifyPassword(const std::string& password,
                    const std::string& stored_hash,
                    const std::string& stored_salt) {
    auto salt = base64Decode(stored_salt);
    auto expected = base64Decode(stored_hash);
    
    std::vector<uint8_t> computed(expected.size());
    
    argon2id_hash_raw(
        3, 65536, 4,
        password.c_str(), password.size(),
        salt.data(), salt.size(),
        computed.data(), computed.size()
    );
    
    // 常量时间比较（防时序攻击）
    return CRYPTO_memcmp(computed.data(), expected.data(), expected.size()) == 0;
}
```

参数选型建议：

| 场景 | t_cost | m_cost | 单次耗时 | 适用 |
|------|--------|--------|---------|------|
| Web登录 | 2 | 19MB | ~100ms | 延迟敏感 |
| API认证 | 3 | 64MB | ~300ms | 标准推荐 |
| 离线加密 | 4 | 256MB | ~1s | 最高安全 |

---

### 2. 数字签名：接口鉴权的正确姿势

#### 2.1 HMAC 签名（对称）

共享密钥签名，适用于服务间通信（双方都有密钥）：

```cpp
#include <openssl/hmac.h>
#include <openssl/evp.h>

// HMAC-SHA256签名
std::string hmacSign(const std::string& message, const std::string& secret) {
    unsigned char digest[EVP_MAX_MD_SIZE];
    unsigned int digest_len;
    
    HMAC(EVP_sha256(),
         secret.c_str(), secret.size(),
         reinterpret_cast<const unsigned char*>(message.c_str()), message.size(),
         digest, &digest_len);
    
    return hexEncode(digest, digest_len);
}

// API请求签名方案
std::string signRequest(const std::string& method,
                        const std::string& path,
                        const std::string& timestamp,
                        const std::string& body,
                        const std::string& secret_key) {
    // 构造签名字符串（规范化，防止歧义）
    std::string string_to_sign = method + "\n"
                                + path + "\n"
                                + timestamp + "\n"
                                + sha256(body);  // body太大时只签摘要
    
    return hmacSign(string_to_sign, secret_key);
}

// 验签（服务端）
bool verifyRequest(const Request& req, const std::string& secret_key) {
    // 1. 时间戳防重放（5分钟窗口）
    auto timestamp = req.getHeader("X-Timestamp");
    auto now = std::time(nullptr);
    if (std::abs(now - std::stol(timestamp)) > 300) {
        return false;  // 过期请求
    }
    
    // 2. 重新计算签名
    auto expected = signRequest(
        req.method(), req.path(), timestamp, req.body(), secret_key);
    
    // 3. 常量时间比较
    auto provided = req.getHeader("X-Signature");
    return constantTimeEqual(expected, provided);
}
```

#### 2.2 Ed25519 签名（非对称）

公钥签名，适用于开放API（发布者用私钥签名，验证者只需公钥）：

```cpp
#include <openssl/evp.h>
#include <openssl/pem.h>

// Ed25519签名
std::vector<uint8_t> ed25519Sign(const std::string& message, EVP_PKEY* private_key) {
    EVP_MD_CTX* ctx = EVP_MD_CTX_new();
    
    EVP_DigestSignInit(ctx, nullptr, nullptr, nullptr, private_key);
    
    size_t sig_len;
    EVP_DigestSign(ctx, nullptr, &sig_len,
                   reinterpret_cast<const unsigned char*>(message.c_str()),
                   message.size());
    
    std::vector<uint8_t> signature(sig_len);
    EVP_DigestSign(ctx, signature.data(), &sig_len,
                   reinterpret_cast<const unsigned char*>(message.c_str()),
                   message.size());
    
    signature.resize(sig_len);
    EVP_MD_CTX_free(ctx);
    return signature;
}

// Ed25519验签
bool ed25519Verify(const std::string& message,
                   const std::vector<uint8_t>& signature,
                   EVP_PKEY* public_key) {
    EVP_MD_CTX* ctx = EVP_MD_CTX_new();
    
    EVP_DigestVerifyInit(ctx, nullptr, nullptr, nullptr, public_key);
    
    int rc = EVP_DigestVerify(ctx, signature.data(), signature.size(),
                              reinterpret_cast<const unsigned char*>(message.c_str()),
                              message.size());
    
    EVP_MD_CTX_free(ctx);
    return rc == 1;
}
```

HMAC vs Ed25519 选型：

| 维度 | HMAC-SHA256 | Ed25519 |
|------|-------------|---------|
| 类型 | 对称（共享密钥） | 非对称（公私钥） |
| 速度 | 极快 (~GB/s) | 快 (~50K签名/s) |
| 密钥管理 | 双方都需要密钥 | 只需分发公钥 |
| 适用 | 服务间（双方可信） | 开放API、Webhook |
| 安全风险 | 密钥泄露=冒充任一方 | 私钥泄露=冒充签名方 |

---

### 3. 密钥存储：最关键的问题

密钥存储的安全等级从低到高：

```
密钥存储方案梯度：

  ❌ Level 0: 硬编码在代码中
     const char* SECRET = "abc123";
     风险: git history永久暴露

  ❌ Level 1: 配置文件（明文）
     config.yml: secret_key: "abc123"
     风险: 任何有文件系统访问权的人可读

  🟡 Level 2: 环境变量
     export SECRET_KEY="abc123"
     风险: /proc/PID/environ、ps aux、日志泄露

  🟡 Level 3: 加密配置文件 + 主密钥
     用一个主密钥加密所有其他密钥
     风险: 主密钥本身如何保护？

  ✅ Level 4: 密钥管理服务(KMS)
     HashiCorp Vault / AWS KMS / 阿里云KMS
     特点: 审计日志、访问控制、自动轮换

  ✅ Level 5: 硬件安全模块(HSM)
     密钥永不离开硬件，签名在HSM内完成
     适用: 金融、CA根证书、合规要求
```

#### HashiCorp Vault 集成

{% raw %}
```cpp
// Vault客户端：运行时获取密钥，不落盘
#include <curl/curl.h>
#include <nlohmann/json.hpp>

class VaultClient {
public:
    VaultClient(const std::string& addr, const std::string& token)
        : addr_(addr), token_(token) {}
    
    // 读取密钥（KV v2引擎）
    std::string getSecret(const std::string& path, const std::string& key) {
        std::string url = addr_ + "/v1/secret/data/" + path;
        
        auto response = httpGet(url, {{"X-Vault-Token", token_}});
        auto json = nlohmann::json::parse(response);
        
        return json["data"]["data"][key].get<std::string>();
    }
    
    // Transit引擎：在Vault内完成加密，密钥永不暴露
    std::string encrypt(const std::string& key_name, const std::string& plaintext) {
        std::string url = addr_ + "/v1/transit/encrypt/" + key_name;
        nlohmann::json body = {{"plaintext", base64Encode(plaintext)}};
        
        auto response = httpPost(url, body.dump(), {{"X-Vault-Token", token_}});
        auto json = nlohmann::json::parse(response);
        
        return json["data"]["ciphertext"].get<std::string>();
        // 返回类似 "vault:v1:abcdef..." 的密文
    }
    
    std::string decrypt(const std::string& key_name, const std::string& ciphertext) {
        std::string url = addr_ + "/v1/transit/decrypt/" + key_name;
        nlohmann::json body = {{"ciphertext", ciphertext}};
        
        auto response = httpPost(url, body.dump(), {{"X-Vault-Token", token_}});
        auto json = nlohmann::json::parse(response);
        
        return base64Decode(json["data"]["plaintext"].get<std::string>());
    }

private:
    std::string addr_;
    std::string token_;
    // httpGet/httpPost 实现省略
};
```
{% endraw %}

---

### 4. 数据加密：信封加密模式

对大量数据加密时，不能直接用KMS（太慢），而是用"信封加密"：

```
信封加密（Envelope Encryption）：

  ┌──────────────────────────────────────────────────────┐
  │  1. 生成随机DEK（Data Encryption Key）               │
  │     DEK = random_256_bits()                          │
  │                                                      │
  │  2. 用DEK加密数据（AES-256-GCM，极快）               │
  │     ciphertext = AES_GCM_Encrypt(DEK, plaintext)     │
  │                                                      │
  │  3. 用KMS主密钥(KEK)加密DEK                          │
  │     encrypted_DEK = KMS_Encrypt(KEK, DEK)            │
  │                                                      │
  │  4. 存储：encrypted_DEK + ciphertext                 │
  │     (DEK明文从内存中擦除)                             │
  └──────────────────────────────────────────────────────┘

  解密：
  1. 从KMS解密DEK: DEK = KMS_Decrypt(KEK, encrypted_DEK)
  2. 用DEK解密数据: plaintext = AES_GCM_Decrypt(DEK, ciphertext)
  3. 擦除DEK

  优势：
  - 大数据加密用本地AES（快）
  - 密钥保护交给KMS（安全）
  - 轮换KEK不需要重新加密所有数据
```

C++实现：

```cpp
#include <openssl/evp.h>
#include <openssl/rand.h>

struct EncryptedData {
    std::vector<uint8_t> encrypted_dek;  // KMS加密后的DEK
    std::vector<uint8_t> iv;             // AES-GCM IV（12字节）
    std::vector<uint8_t> ciphertext;     // AES-GCM密文
    std::vector<uint8_t> tag;            // AES-GCM认证标签（16字节）
};

EncryptedData envelopeEncrypt(const std::string& plaintext, VaultClient& vault) {
    // 1. 生成随机DEK（256 bit）
    std::vector<uint8_t> dek(32);
    RAND_bytes(dek.data(), dek.size());
    
    // 2. 生成随机IV（96 bit，GCM推荐）
    std::vector<uint8_t> iv(12);
    RAND_bytes(iv.data(), iv.size());
    
    // 3. AES-256-GCM加密数据
    EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
    EVP_EncryptInit_ex(ctx, EVP_aes_256_gcm(), nullptr, dek.data(), iv.data());
    
    std::vector<uint8_t> ciphertext(plaintext.size() + 16);
    int out_len;
    EVP_EncryptUpdate(ctx, ciphertext.data(), &out_len,
                      reinterpret_cast<const uint8_t*>(plaintext.c_str()),
                      plaintext.size());
    int total_len = out_len;
    EVP_EncryptFinal_ex(ctx, ciphertext.data() + out_len, &out_len);
    total_len += out_len;
    ciphertext.resize(total_len);
    
    // 获取认证标签
    std::vector<uint8_t> tag(16);
    EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, 16, tag.data());
    EVP_CIPHER_CTX_free(ctx);
    
    // 4. 用Vault Transit加密DEK
    auto encrypted_dek_str = vault.encrypt("data-key",
        std::string(dek.begin(), dek.end()));
    
    // 5. 安全擦除DEK明文
    OPENSSL_cleanse(dek.data(), dek.size());
    
    return {
        std::vector<uint8_t>(encrypted_dek_str.begin(), encrypted_dek_str.end()),
        iv, ciphertext, tag
    };
}
```

---

### 5. Token 签发系统设计

一个完整的Token系统需要考虑签发、验证、刷新和吊销：

```
Token系统架构：

  登录请求                         Token验证请求
  ─────>                          ─────>
  
  ┌──────────────────────────────────────────────────────┐
  │                 Auth Service                          │
  │                                                      │
  │  签发流程:                     验证流程:              │
  │  1. 验证用户凭证               1. 解码JWT             │
  │  2. 生成access_token(短期)    2. 验证签名(Ed25519)   │
  │  3. 生成refresh_token(长期)   3. 检查过期时间        │
  │  4. 存储refresh到Redis        4. 检查黑名单          │
  │  5. 返回双Token               5. 提取用户信息        │
  └──────────────────────────────────────────────────────┘

  Token生命周期:
  access_token:  15分钟（短期，不可吊销，减少查库）
  refresh_token: 7天（长期，可吊销，存储在服务端）
```

| 设计决策 | 推荐方案 | 原因 |
|---------|---------|------|
| 签名算法 | Ed25519 (EdDSA) | 比RS256快4倍，签名更短 |
| access有效期 | 15分钟 | 短到即使泄露影响有限 |
| refresh有效期 | 7天 | 平衡安全和用户体验 |
| Token吊销 | Redis黑名单(仅access) | access短期自然过期，refresh直接删除 |
| 密钥轮换 | kid字段标识密钥版本 | 无缝切换新密钥 |

---

### 6. 密码学工程检查清单

| 场景 | ✅ 正确做法 | ❌ 常见错误 |
|------|-----------|-----------|
| 密码存储 | Argon2id / bcrypt | MD5, SHA-256, 不加salt |
| API签名 | HMAC-SHA256 + 时间戳 + nonce | MD5(params+key) |
| 数据加密 | AES-256-GCM (AEAD) | AES-ECB, DES, RC4 |
| 随机数 | /dev/urandom, RAND_bytes | rand(), 时间戳种子 |
| 密钥存储 | Vault/KMS | 环境变量/配置文件/代码 |
| 比较操作 | CRYPTO_memcmp | strcmp, == |
| 密钥派生 | HKDF | 直接截取hash |
| Token | JWT + Ed25519 + 短有效期 | 自定义格式 + 永不过期 |

---

### 总结

密码学工程的核心原则：

1. **不要自己造轮子**：用成熟库（OpenSSL、libsodium），不自己实现加密算法
2. **密码哈希要慢**：Argon2id(t=3,m=64MB)是当前最佳选择，bcrypt是可接受的替代
3. **对称密钥不出主机**：用KMS/Vault的Transit引擎，密钥在服务内完成加密
4. **信封加密是标准模式**：大数据用本地AES（快），密钥用KMS保护（安全）
5. **签名需要时间戳和nonce**：防重放攻击
6. **常量时间是必须的**：所有密码学比较操作必须用constant-time函数

密码学不是"加个加密就安全了"。每个环节（生成、存储、使用、传输、轮换、销毁）都有正确的做法。做对了，系统固若金汤；做错一个环节，整条链路的安全性归零。

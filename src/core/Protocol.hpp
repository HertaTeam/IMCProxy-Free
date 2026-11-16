#pragma once

#include <cstdint>
#include <string>
#include <string_view>

namespace imcp::core {

class Reader {
public:
    explicit Reader(std::string_view data) : data_(data) {}

    bool empty() const { return pos_ >= data_.size(); }
    size_t remaining() const { return data_.size() - pos_; }
    size_t pos() const { return pos_; }

    uint8_t u8();
    int8_t i8();
    uint16_t u16();
    int16_t i16();
    int32_t i32();
    int64_t i64();
    float f32();
    double f64();
    bool boolean();

    int32_t varint();
    int64_t varlong();

    std::string string();
    std::string bytes(size_t count);

    std::string_view rest();

private:
    std::string_view data_;
    size_t pos_ = 0;
};

class Writer {
public:
    void u8(uint8_t value);
    void i8(int8_t value);
    void u16(uint16_t value);
    void i16(int16_t value);
    void i32(int32_t value);
    void i64(int64_t value);
    void f32(float value);
    void f64(double value);
    void boolean(bool value);
    void varint(int32_t value);
    void varlong(int64_t value);
    void string(std::string_view value);
    void raw(std::string_view value);

    const std::string& data() const { return buffer_; }
    std::string take();

private:
    std::string buffer_;
};

int32_t varint_size(int32_t value);
int32_t read_varint_at(std::string_view data, size_t& offset);
std::string write_varint(int32_t value);

}

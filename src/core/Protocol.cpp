#include "core/Protocol.hpp"

#include <cstring>
#include <stdexcept>

namespace imcp::core {

namespace {
template <typename T>
T read_be(std::string_view data, size_t& pos) {
    if (pos + sizeof(T) > data.size()) throw std::runtime_error("read past end");
    T value{};
    std::memcpy(&value, data.data() + pos, sizeof(T));
    pos += sizeof(T);
    if constexpr (sizeof(T) > 1) {
        uint8_t* raw = reinterpret_cast<uint8_t*>(&value);
        for (size_t i = 0; i < sizeof(T) / 2; ++i) std::swap(raw[i], raw[sizeof(T) - 1 - i]);
    }
    return value;
}

template <typename T>
void write_be(std::string& out, T value) {
    uint8_t raw[sizeof(T)];
    std::memcpy(raw, &value, sizeof(T));
    for (size_t i = 0; i < sizeof(T) / 2; ++i) std::swap(raw[i], raw[sizeof(T) - 1 - i]);
    out.append(reinterpret_cast<const char*>(raw), sizeof(T));
}
}

uint8_t Reader::u8() {
    if (pos_ >= data_.size()) throw std::runtime_error("read past end");
    return static_cast<uint8_t>(data_[pos_++]);
}

int8_t Reader::i8() { return static_cast<int8_t>(u8()); }

uint16_t Reader::u16() { return read_be<uint16_t>(data_, pos_); }
int16_t Reader::i16() { return read_be<int16_t>(data_, pos_); }
int32_t Reader::i32() { return read_be<int32_t>(data_, pos_); }
int64_t Reader::i64() { return read_be<int64_t>(data_, pos_); }
float Reader::f32() { return read_be<float>(data_, pos_); }
double Reader::f64() { return read_be<double>(data_, pos_); }
bool Reader::boolean() { return u8() != 0; }

int32_t Reader::varint() {
    uint32_t result = 0;
    for (int shift = 0; shift <= 28; shift += 7) {
        const uint8_t byte = u8();
        if (shift == 28 && (byte & 0xf0)) throw std::runtime_error("varint too long");
        result |= static_cast<uint32_t>(byte & 0x7f) << shift;
        if ((byte & 0x80) == 0) return static_cast<int32_t>(result);
    }
    throw std::runtime_error("varint too long");
}

int64_t Reader::varlong() {
    int64_t result = 0;
    int shift = 0;
    while (true) {
        uint8_t byte = u8();
        result |= static_cast<int64_t>(byte & 0x7F) << shift;
        if ((byte & 0x80) == 0) break;
        shift += 7;
        if (shift > 70) throw std::runtime_error("varlong too long");
    }
    return result;
}

std::string Reader::string() {
    int32_t length = varint();
    if (length < 0 || static_cast<size_t>(length) > remaining()) throw std::runtime_error("bad string length");
    std::string value(data_.substr(pos_, static_cast<size_t>(length)));
    pos_ += static_cast<size_t>(length);
    return value;
}

std::string Reader::bytes(size_t count) {
    if (count > remaining()) throw std::runtime_error("bad byte length");
    std::string value(data_.substr(pos_, count));
    pos_ += count;
    return value;
}

std::string_view Reader::rest() {
    std::string_view value = data_.substr(pos_);
    pos_ = data_.size();
    return value;
}

void Writer::u8(uint8_t value) { buffer_.push_back(static_cast<char>(value)); }
void Writer::i8(int8_t value) { buffer_.push_back(static_cast<char>(value)); }
void Writer::u16(uint16_t value) { write_be<uint16_t>(buffer_, value); }
void Writer::i16(int16_t value) { write_be<int16_t>(buffer_, value); }
void Writer::i32(int32_t value) { write_be<int32_t>(buffer_, value); }
void Writer::i64(int64_t value) { write_be<int64_t>(buffer_, value); }
void Writer::f32(float value) { write_be<float>(buffer_, value); }
void Writer::f64(double value) { write_be<double>(buffer_, value); }
void Writer::boolean(bool value) { buffer_.push_back(value ? '\x01' : '\x00'); }

void Writer::varint(int32_t value) {
    uint32_t rest = static_cast<uint32_t>(value);
    while (true) {
        if ((rest & ~static_cast<uint32_t>(0x7F)) == 0) {
            buffer_.push_back(static_cast<char>(rest));
            return;
        }
        buffer_.push_back(static_cast<char>((rest & 0x7F) | 0x80));
        rest >>= 7;
    }
}

void Writer::varlong(int64_t value) {
    uint64_t rest = static_cast<uint64_t>(value);
    while (true) {
        if ((rest & ~static_cast<uint64_t>(0x7F)) == 0) {
            buffer_.push_back(static_cast<char>(rest));
            return;
        }
        buffer_.push_back(static_cast<char>((rest & 0x7F) | 0x80));
        rest >>= 7;
    }
}

void Writer::string(std::string_view value) {
    varint(static_cast<int32_t>(value.size()));
    buffer_.append(value.data(), value.size());
}

void Writer::raw(std::string_view value) { buffer_.append(value.data(), value.size()); }

std::string Writer::take() {
    std::string value = std::move(buffer_);
    buffer_.clear();
    return value;
}

int32_t varint_size(int32_t value) {
    uint32_t rest = static_cast<uint32_t>(value);
    int32_t size = 1;
    while ((rest & ~static_cast<uint32_t>(0x7F)) != 0) {
        ++size;
        rest >>= 7;
    }
    return size;
}

int32_t read_varint_at(std::string_view data, size_t& offset) {
    int32_t result = 0;
    int shift = 0;
    while (true) {
        if (offset >= data.size()) throw std::runtime_error("varint read past end");
        uint8_t byte = static_cast<uint8_t>(data[offset++]);
        result |= static_cast<int32_t>(byte & 0x7F) << shift;
        if ((byte & 0x80) == 0) break;
        shift += 7;
        if (shift > 35) throw std::runtime_error("varint too long");
    }
    return result;
}

std::string write_varint(int32_t value) {
    Writer writer;
    writer.varint(value);
    return writer.take();
}

}

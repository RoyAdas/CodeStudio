#include "total.hpp"

int total(const std::vector<int>& values) {
    int result = 0;
    for (const int value : values) result += value;
    return result;
}
